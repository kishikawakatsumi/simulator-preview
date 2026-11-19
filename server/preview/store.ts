import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHubBuilds, type BuildMetadata } from "./github.js";
import {
  PreviewError,
  type BuildReference,
  type PreviewConfig,
} from "./config.js";
const exec = promisify(execFile);
export interface PreparedBuild extends BuildMetadata {
  appPath: string;
  bundleID: string;
  minimumOS: string;
}
interface Job {
  state: "preparing" | "ready" | "error";
  message: string;
  build?: PreparedBuild;
  status?: number;
  done?: Promise<void>;
}
async function sizeOf(path: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) size += await sizeOf(join(path, entry.name));
    else if (entry.isFile()) size += (await stat(join(path, entry.name))).size;
  }
  return size;
}
export class PreviewStore {
  private jobs = new Map<string, Job>();
  private queue = Promise.resolve();
  private closing = false;
  constructor(
    readonly config: PreviewConfig,
    private github = new GitHubBuilds(config),
  ) {}
  start(ref: BuildReference) {
    if (this.closing)
      throw new PreviewError(503, "Preview server is stopping.");
    if (this.config.demo && ref.key !== "1-1")
      throw new PreviewError(404, "The local demo is at /builds/1/1.");
    const existing = this.jobs.get(ref.key);
    if (existing && existing.state !== "error") return this.status(ref);
    if (this.jobs.size >= 32 && !existing) {
      const disposable = [...this.jobs].find(
        ([, job]) => job.state !== "preparing",
      );
      if (!disposable)
        throw new PreviewError(
          429,
          "Too many builds are preparing. Try again shortly.",
        );
      this.jobs.delete(disposable[0]);
    }
    const job: Job = {
      state: "preparing",
      message: "Waiting to prepare this build…",
    };
    this.jobs.set(ref.key, job);
    job.done = this.queue.then(async () => {
      try {
        job.message = "Verifying the pull request build…";
        job.build = await this.prepare(ref, (message) => {
          job.message = message;
        });
        job.state = "ready";
        job.message = "Build ready";
      } catch (error) {
        job.state = "error";
        job.status = error instanceof PreviewError ? error.status : 500;
        job.message =
          error instanceof PreviewError
            ? error.message
            : "Could not prepare the app. Check the server log, then retry.";
        console.error(
          `Preview preparation failed (${ref.key}):`,
          error instanceof Error ? error.message : "Unknown failure",
        );
      }
    });
    this.queue = job.done;
    return this.status(ref);
  }
  status(ref: BuildReference) {
    const job = this.jobs.get(ref.key);
    if (!job)
      throw new PreviewError(
        404,
        "Open the preview page to prepare this build first.",
      );
    if (job.build && Date.parse(job.build.expiresAt) <= Date.now())
      throw new PreviewError(
        410,
        "This preview has expired. Re-run the build.",
      );
    const b = job.build;
    return {
      state: job.state,
      message: job.message,
      status: job.status,
      ...(b
        ? {
            build: {
              repository: b.repository,
              run: b.run,
              artifact: b.artifact,
              sha: b.sha,
              pr: b.pr,
              title: b.title,
              minimumOS: b.minimumOS,
              bundleID: b.bundleID,
              expiresAt: b.expiresAt,
            },
          }
        : {}),
    };
  }
  get(ref: BuildReference): PreparedBuild {
    this.status(ref);
    const job = this.jobs.get(ref.key)!;
    if (job.state !== "ready" || !job.build)
      throw new PreviewError(409, "Build is not ready yet.");
    return job.build;
  }
  private async prepare(
    ref: BuildReference,
    progress: (message: string) => void,
  ): Promise<PreparedBuild> {
    const metadata: BuildMetadata = this.config.demo
      ? {
          repository: "local/demo",
          run: ref.run,
          artifact: ref.artifact,
          pr: 1,
          title: "Simulator Preview Demo",
          sha: "0000000000000000000000000000000000000000",
          expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
          digest: "local-demo",
        }
      : await this.github.metadata(ref);
    await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
    const destination = join(this.config.directory, ref.key);
    if (!this.config.demo) {
      try {
        const cached = JSON.parse(
          await readFile(join(destination, "build.json"), "utf8"),
        ) as PreparedBuild;
        if (
          cached.digest === metadata.digest &&
          cached.appPath === join(destination, "app", "App.app") &&
          (await stat(cached.appPath)).isDirectory()
        )
          return { ...cached, ...metadata };
      } catch {
        /* Rebuild incomplete caches. */
      }
    }
    // Reserve enough free cache quota for one maximally expanded build. No active cache is evicted.
    if (
      (await sizeOf(this.config.directory)) >
      this.config.maxCache - 3 * 1024 ** 3
    )
      throw new PreviewError(
        507,
        "Preview cache is full. Ask the host administrator to clear old builds while the server is stopped.",
      );
    const temp = await mkdtemp(join(this.config.directory, ".download-"));
    try {
      const zip = join(temp, "artifact.zip");
      progress("Downloading the simulator app…");
      if (this.config.demo)
        await cp(this.config.demoArchive, zip, {
          errorOnExist: true,
          force: false,
        });
      else await this.github.download(ref, zip, metadata.digest);
      progress("Checking and unpacking the simulator app…");
      const script = fileURLToPath(
        new URL("../../../scripts/unpack-preview.py", import.meta.url),
      );
      const { stdout } = await exec(
        "/usr/bin/python3",
        [script, zip, join(temp, "app")],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
      );
      const info = JSON.parse(stdout) as {
        appPath: string;
        executable: string;
        bundleID: string;
        minimumOS: string;
      };
      const { stdout: architectures } = await exec(
        "/usr/bin/xcrun",
        ["lipo", "-archs", info.executable],
        { timeout: 20_000 },
      );
      if (
        !architectures
          .split(/\s+/)
          .includes(process.arch === "arm64" ? "arm64" : "x86_64")
      )
        throw new PreviewError(
          422,
          "The app does not contain the architecture required by this Mac.",
        );
      const { stdout: platform } = await exec(
        "/usr/bin/xcrun",
        [
          "vtool",
          "-arch",
          process.arch === "arm64" ? "arm64" : "x86_64",
          "-show-build",
          info.executable,
        ],
        { timeout: 20_000 },
      );
      if (!/platform\s+IOSSIMULATOR\b/.test(platform))
        throw new PreviewError(
          422,
          "The executable was not built for iOS Simulator.",
        );
      const build: PreparedBuild = {
        ...metadata,
        appPath: join(destination, "app", "App.app"),
        bundleID: info.bundleID,
        minimumOS: info.minimumOS,
      };
      await rm(zip);
      await writeFile(join(temp, "build.json"), JSON.stringify(build), {
        mode: 0o600,
      });
      await rm(destination, { recursive: true, force: true });
      await rename(temp, destination);
      return build;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async close() {
    this.closing = true;
    await this.queue;
  }
}

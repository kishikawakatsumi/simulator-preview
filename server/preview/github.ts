import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import type { PreviewConfig, BuildReference } from "./config.js";
import { PreviewError } from "./config.js";

export interface BuildMetadata {
  repository: string;
  run: string;
  artifact: string;
  sha: string;
  pr: number;
  title: string;
  expiresAt: string;
  digest: string;
}
export class GitHubBuilds {
  constructor(
    private config: PreviewConfig,
    private request: typeof fetch = fetch,
  ) {}
  private async api(path: string) {
    const response = await this.request(
      `https://api.github.com/repos/${this.config.repository}${path}`,
      {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new PreviewError(
        response.status === 404 ? 404 : 502,
        response.status === 404
          ? "This build is unavailable or has expired."
          : "Could not verify the build with GitHub. Try again shortly.",
      );
    return response;
  }
  async metadata(ref: BuildReference): Promise<BuildMetadata> {
    const [run, artifact] = (await Promise.all([
      this.api(`/actions/runs/${ref.run}`).then((r) => r.json()),
      this.api(`/actions/artifacts/${ref.artifact}`).then((r) => r.json()),
    ])) as any[];
    const same = (name: unknown) =>
      typeof name === "string" &&
      name.toLowerCase() === this.config.repository.toLowerCase();
    if (
      String(run.id) !== ref.run ||
      !same(run.repository?.full_name) ||
      !same(run.head_repository?.full_name) ||
      run.event !== "pull_request" ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      run.path !== this.config.workflow ||
      !/^[a-f0-9]{40}$/.test(run.head_sha ?? "") ||
      String(artifact.id) !== ref.artifact ||
      artifact.name !== this.config.artifactName ||
      String(artifact.workflow_run?.id) !== ref.run ||
      artifact.workflow_run?.head_sha !== run.head_sha ||
      artifact.workflow_run?.head_repository_id !== run.repository?.id
    ) {
      throw new PreviewError(
        403,
        "This artifact is not from an approved successful pull request build.",
      );
    }
    if (artifact.expired || !(Date.parse(artifact.expires_at) > Date.now()))
      throw new PreviewError(
        410,
        "This preview has expired. Re-run the build in GitHub Actions.",
      );
    if (
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes > this.config.maxDownload ||
      artifact.size_in_bytes < 1
    )
      throw new PreviewError(
        413,
        "The build is too large for this preview server.",
      );
    if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? ""))
      throw new PreviewError(
        403,
        "The artifact does not have a supported integrity digest. Rebuild with upload-artifact.",
      );
    const prs = (run.pull_requests ?? []).filter(
      (pr: any) => Number.isSafeInteger(pr.number) && pr.number > 0,
    );
    if (prs.length !== 1)
      throw new PreviewError(
        403,
        "Could not uniquely identify the pull request for this build.",
      );
    const pr = (await (
      await this.api(`/pulls/${prs[0].number}`)
    ).json()) as any;
    if (!same(pr.head?.repo?.full_name) || !same(pr.base?.repo?.full_name))
      throw new PreviewError(
        403,
        "Fork pull requests are not enabled for this experiment.",
      );
    return {
      repository: this.config.repository,
      run: ref.run,
      artifact: ref.artifact,
      sha: run.head_sha,
      pr: pr.number,
      title: String(pr.title).slice(0, 200),
      expiresAt: artifact.expires_at,
      digest: artifact.digest,
    };
  }
  async download(ref: BuildReference, destination: string, digest: string) {
    // Fetch the API redirect explicitly: never forward the GitHub credential to storage.
    const response = await this.request(
      `https://api.github.com/repos/${this.config.repository}/actions/artifacts/${ref.artifact}/zip`,
      {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/vnd.github+json",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status !== 302 || !response.headers.get("location"))
      throw new PreviewError(
        502,
        "Could not download the build. It may have expired.",
      );
    const location = new URL(response.headers.get("location")!);
    if (
      location.protocol !== "https:" ||
      location.username ||
      location.password
    )
      throw new PreviewError(502, "Invalid artifact download response.");
    const archive = await this.request(location, {
      redirect: "error",
      signal: AbortSignal.timeout(180_000),
    });
    if (!archive.ok || !archive.body)
      throw new PreviewError(502, "Artifact download failed. Please retry.");
    const file = await open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of archive.body) {
        size += chunk.length;
        if (size > this.config.maxDownload)
          throw new PreviewError(
            413,
            "Artifact exceeds the download size limit.",
          );
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (`sha256:${hash.digest("hex")}` !== digest)
        throw new PreviewError(403, "Artifact integrity check failed.");
    } catch (error) {
      await unlink(destination).catch(() => {});
      throw error;
    } finally {
      await file.close();
    }
  }
}

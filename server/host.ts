import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { HostDecoder, type HostStatus } from "./protocol.js";
import type { Config } from "./config.js";

export class SimulatorHost extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private stopping = false;
  status: HostStatus = {
    type: "status",
    connected: false,
    ready: false,
    busy: false,
    switching: false,
    revision: 0,
    width: 0,
    height: 0,
    device: "",
    supportsHinge: false,
    error: "",
  };

  start(config: Config) {
    const args = [
      "--fps",
      String(config.fps),
      "--max-edge",
      String(config.maxEdge),
    ];
    if (config.testPattern) args.push("--test-pattern");
    for (const [flag, value] of [
      ["--device", config.device],
      ["--app", config.appPath],
      ["--bundle-id", config.bundleID],
    ]) {
      if (value) args.push(flag!, value);
    }
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.CF_TURN_API_TOKEN;
    const child = spawn(config.hostPath, args, { stdio: "pipe", env });
    this.process = child;
    const decoder = new HostDecoder(
      (status) => {
        this.status = status;
        this.emit("status", status);
      },
      (frame) => this.emit("frame", frame),
    );
    child.stdout.on("data", (chunk) => {
      try {
        decoder.push(chunk);
      } catch {
        this.fail("Invalid response from simulator host");
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", () =>
      this.fail("Simulator host could not start. Run npm run build:native."),
    );
    child.on("exit", () => {
      if (!this.stopping)
        this.fail("Simulator host stopped. Restart Simulator Preview.");
    });
    child.stdin.on("error", () => {
      if (!this.stopping) this.fail("Simulator host input closed");
    });
    this.send({ type: "bitrate", value: config.bitrate });
  }

  send(command: object) {
    const input = this.process?.stdin;
    if (!input || input.destroyed || this.stopping) return;
    // Never queue unbounded input: a stuck host must release ownership via failure.
    if (input.writableLength > 64 * 1024) {
      this.fail("Simulator host is not accepting input");
      this.process?.kill();
      return;
    }
    input.write(`${JSON.stringify(command)}\n`);
  }

  private fail(error: string) {
    this.status = {
      ...this.status,
      connected: false,
      preview: false,
      ready: false,
      busy: false,
      switching: false,
      error,
    };
    this.emit("status", this.status);
  }

  async stop() {
    this.stopping = true;
    const child = this.process;
    if (!child?.pid || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  }
}

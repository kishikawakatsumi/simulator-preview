import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { SimulatorHost } from "./host.js";
import { ControlLease } from "./control.js";
import type { Config } from "./config.js";
import type { HostStatus, VideoFrame } from "./protocol.js";
import type { Device } from "./devices.js";
import {
  ManagedDevices,
  type Assignment,
  type DeviceAssignments,
} from "./assignments.js";

export class StudioSession extends EventEmitter {
  readonly host: SimulatorHost;
  readonly control: ControlLease;
  references = 0;
  idleSince = Date.now();
  closing = false;
  lastKeyframe = 0;
  lastBitrate: number;
  assignment?: Assignment;
  private preparing = false;
  private lastHostError = "";
  private hostError = "";
  private preparationError = "";
  private selecting?: Promise<void>;
  private retired = new Set<Assignment>();
  private retiring?: Promise<void>;
  constructor(
    readonly key: string,
    private config: Config,
    private devices: DeviceAssignments,
    createHost: () => SimulatorHost,
  ) {
    super();
    this.host = createHost();
    this.lastBitrate = config.bitrate;
    this.control = new ControlLease(
      (command) => this.host.send(command),
      () => this.emit("control"),
    );
    this.host.on("status", (status: HostStatus) => {
      if (this.closing) return;
      if (status.error !== this.lastHostError) {
        this.lastHostError = status.error;
        this.hostError = status.error ? this.reportError(status.error) : "";
      }
      if (status.error) this.preparing = false;
      if (this.assignment && status.udid === this.assignment.udid)
        this.preparing = false;
      if (!this.status.ready) this.control.cancel();
      this.emit("status", this.status);
      if (
        status.connected &&
        status.udid === this.assignment?.udid &&
        !this.retiring
      ) {
        this.retiring = this.stopRetired()
          .catch((error) =>
            console.error("Could not stop previous simulator:", error),
          )
          .finally(() => {
            this.retiring = undefined;
          });
      }
    });
    this.host.on("frame", (frame: VideoFrame) => {
      if (!this.closing && !this.preparing) this.emit("frame", frame);
    });
  }
  get status(): HostStatus {
    const status = this.host.status;
    return {
      ...status,
      error: this.preparationError || this.hostError,
      ...(this.assignment
        ? {
            udid: this.assignment.template.udid,
            device: this.assignment.template.name,
          }
        : {}),
      ...(this.preparing
        ? {
            ready: false,
            connected: false,
            preview: false,
            busy: true,
            switching: true,
            error: "",
          }
        : {}),
    };
  }
  async start() {
    if (!this.config.testPattern)
      this.assignment = await this.devices.current(this.key);
    this.preparing = !!this.assignment;
    this.host.start({ ...this.config, device: this.assignment?.udid });
  }
  async select(viewer: string, template: Device) {
    if (
      this.closing ||
      this.selecting ||
      this.control.owner !== viewer ||
      this.status.busy ||
      this.status.switching
    )
      return;
    if (
      this.assignment?.template.udid === template.udid &&
      this.host.status.connected
    )
      return;
    this.preparationError = "";
    this.hostError = "";
    this.lastHostError = "";
    this.preparing = true;
    this.control.cancel();
    this.emit("status", this.status);
    this.selecting = (async () => {
      try {
        await this.retiring;
        await this.stopRetired();
        const previous = this.assignment;
        const next = await this.devices.provision(this.key, template);
        this.assignment = next;
        if (previous && previous.udid !== next.udid) this.retired.add(previous);
        // Commands only contain the device selected by the server, never a client-supplied instance ID.
        if (!this.closing)
          this.host.send({ type: "select-device", udid: next.udid });
      } catch (error) {
        this.preparing = false;
        this.preparationError = this.reportError(error);
        this.emit("status", this.status);
      }
    })();
    try {
      await this.selecting;
    } finally {
      this.selecting = undefined;
    }
  }
  private reportError(error: unknown) {
    const reference = randomUUID().slice(0, 8);
    console.error(
      `[${new Date().toISOString()}] Simulator error ${reference} (session ${this.key.slice(0, 12)}):`,
      error,
    );
    return `The simulator could not complete this operation. Contact the host administrator if it keeps failing. Reference: ${reference}.`;
  }
  private async stopRetired() {
    for (const assignment of this.retired) {
      await this.devices.stop(assignment);
      this.retired.delete(assignment);
    }
  }
  async close() {
    this.closing = true;
    this.control.cancel();
    await this.selecting;
    await this.host.stop();
    await this.retiring;
    await this.stopRetired();
    if (this.assignment) await this.devices.stop(this.assignment);
    this.removeAllListeners();
  }
}

export interface SessionOptions {
  devices?: DeviceAssignments;
  createHost?: () => SimulatorHost;
}

/** A bounded set of running sessions. Stopped device data stays in CoreSimulator for reconnects. */
export class SessionPool {
  readonly sessions = new Map<string, StudioSession>();
  readonly ready: Promise<void>;
  private devices: DeviceAssignments;
  private createHost: () => SimulatorHost;
  private queue = Promise.resolve();
  private closing = false;
  private sweeping = false;
  private cleanupRetryAt = 0;
  constructor(
    private config: Config,
    options: SessionOptions = {},
    private opened: (session: StudioSession) => void = () => {},
  ) {
    this.devices = options.devices ?? new ManagedDevices(config.stateDirectory);
    this.createHost = options.createHost ?? (() => new SimulatorHost());
    this.ready = config.testPattern
      ? Promise.resolve()
      : this.devices.initialize();
    // Surface initialization failures to callers without an unhandled rejection during startup.
    void this.ready.catch(() => {});
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  acquire(
    key: string,
    app?: Pick<Config, "appPath" | "bundleID">,
  ): Promise<StudioSession | undefined> {
    return this.serial(async () => {
      await this.ready;
      if (this.closing) throw new Error("Server is stopping");
      let session = this.sessions.get(key);
      if (session?.closing) {
        await this.stop(session);
        session = undefined;
      }
      if (!session) {
        if (this.sessions.size >= this.config.maxSessions) {
          const idle = [...this.sessions.values()]
            .filter((item) => !item.references)
            .sort((a, b) => a.idleSince - b.idleSince)[0];
          if (!idle) return undefined;
          await this.stop(idle);
        }
        session = new StudioSession(
          key,
          { ...this.config, ...app },
          this.devices,
          this.createHost,
        );
        this.sessions.set(key, session);
        this.opened(session);
        try {
          await session.start();
        } catch (error) {
          await this.stop(session);
          throw error;
        }
      }
      session.references++;
      return session;
    });
  }
  release(session: StudioSession) {
    session.references = Math.max(0, session.references - 1);
    if (!session.references) session.idleSince = Date.now();
  }
  async sweep(now = Date.now()) {
    // Timer ticks must not queue behind a slow simctl call and delay new connections.
    if (this.closing || this.sweeping || now < this.cleanupRetryAt) return;
    this.sweeping = true;
    try {
      await this.serial(async () => {
        for (const session of this.sessions.values()) {
          if (
            !session.references &&
            now - session.idleSince >= this.config.sessionIdleMs
          )
            await this.stop(session);
        }
      });
      this.cleanupRetryAt = 0;
    } catch (error) {
      // Keep failed sessions counted toward capacity; retry after CoreSimulator settles.
      this.cleanupRetryAt = Date.now() + 30_000;
      throw error;
    } finally {
      this.sweeping = false;
    }
  }
  private async stop(session: StudioSession) {
    await session.close();
    this.sessions.delete(session.key);
  }
  async close() {
    this.closing = true;
    await this.serial(async () => {
      try {
        await this.ready;
        const stopped = await Promise.allSettled(
          [...this.sessions.values()].map((session) => this.stop(session)),
        );
        const errors = stopped.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (errors.length)
          throw new AggregateError(
            errors.map((result) => result.reason),
            "Could not stop all simulator sessions",
          );
      } finally {
        if (!this.config.testPattern) await this.devices.close();
      }
    });
  }
}

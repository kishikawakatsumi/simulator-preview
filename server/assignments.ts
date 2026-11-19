import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { listDevices, invalidateDevices, type Device } from "./devices.js";

const exec = promisify(execFile);
export const identifier =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sessionKey(
  issuer: string,
  user: string,
  client: string,
  workspace: string,
) {
  if (
    !identifier.test(client) ||
    (workspace !== "main" && !identifier.test(workspace))
  )
    throw new Error("Invalid client or workspace");
  return createHash("sha256")
    .update(
      JSON.stringify([
        issuer,
        user,
        client.toLowerCase(),
        workspace.toLowerCase(),
      ]),
    )
    .digest("hex");
}
export interface Assignment {
  udid: string;
  name: string;
  template: Device;
}
export interface DeviceAssignments {
  initialize(): Promise<void>;
  current(key: string): Promise<Assignment | undefined>;
  provision(key: string, template: Device): Promise<Assignment>;
  stop(assignment: Assignment): Promise<void>;
  close(): Promise<void>;
}
interface SimulatorPlatform {
  list(): Promise<Device[]>;
  create(name: string, type: string, runtime: string): Promise<string>;
  shutdown(udid: string): Promise<void>;
}
const systemPlatform: SimulatorPlatform = {
  async list() {
    invalidateDevices();
    return listDevices(true);
  },
  async create(name, type, runtime) {
    const { stdout } = await exec(
      "/usr/bin/xcrun",
      ["simctl", "create", name, type, runtime],
      {
        timeout: 60_000,
      },
    );
    return stdout.trim();
  },
  async shutdown(udid) {
    await exec("/usr/bin/xcrun", ["simctl", "shutdown", udid], {
      timeout: 60_000,
    });
    invalidateDevices();
  },
};
interface State {
  version: 1;
  installation: string;
  current: Record<string, Assignment>;
}

/** One atomic state file, plus dedicated CoreSimulator devices. Never clone another user's data. */
export class ManagedDevices implements DeviceAssignments {
  private state!: State;
  private locked = false;
  private writes = Promise.resolve();
  private file: string;
  private lock: string;
  constructor(
    private directory: string,
    private platform: SimulatorPlatform = systemPlatform,
  ) {
    this.file = path.join(directory, "assignments.json");
    this.lock = path.join(directory, "server.lock");
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const pid = Number(await readFile(this.lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error("Invalid state lock");
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        await unlink(this.lock);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lock = await open(this.lock, "wx", 0o600);
    this.locked = true;
    await lock.writeFile(String(process.pid));
    await lock.close();
    try {
      try {
        this.state = JSON.parse(await readFile(this.file, "utf8")) as State;
        if (
          this.state.version !== 1 ||
          !identifier.test(this.state.installation) ||
          !this.state.current ||
          typeof this.state.current !== "object"
        )
          throw new Error("Invalid simulator assignment state");
        for (const [key, item] of Object.entries(this.state.current)) {
          if (
            !/^[a-f0-9]{64}$/.test(key) ||
            !identifier.test(item.udid) ||
            !item.name.startsWith(this.prefix(key)) ||
            !identifier.test(item.template.udid)
          )
            throw new Error("Invalid simulator assignment");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.state = { version: 1, installation: randomUUID(), current: {} };
        await this.save();
      }
      // Recover after a process crash. Only stop devices belonging to this installation.
      invalidateDevices();
      for (const device of await this.platform.list()) {
        if (
          device.name.startsWith(`Studio-${this.state.installation}-`) &&
          device.state !== "Shutdown"
        )
          await this.stop({
            udid: device.udid,
            name: device.name,
            template: device,
          });
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private prefix(key: string) {
    return `Studio-${this.state.installation}-${key}-`;
  }
  private async save() {
    const contents = JSON.stringify(this.state, null, 2);
    const write = this.writes.then(async () => {
      await writeFile(this.file + ".tmp", contents, { mode: 0o600 });
      await rename(this.file + ".tmp", this.file);
    });
    this.writes = write.catch(() => {});
    await write;
  }
  async current(key: string) {
    const item = this.state.current[key];
    if (!item) return undefined;
    const exists = (await this.platform.list()).some(
      (device) => device.udid === item.udid && device.name === item.name,
    );
    return exists ? item : undefined;
  }
  async provision(key: string, template: Device) {
    if (
      !template.deviceTypeIdentifier ||
      !template.runtimeIdentifier ||
      template.name.startsWith("Studio-")
    )
      throw new Error("This simulator type is unavailable");
    const profile = createHash("sha256")
      .update(
        JSON.stringify([
          template.deviceTypeIdentifier,
          template.runtimeIdentifier,
        ]),
      )
      .digest("hex")
      .slice(0, 16);
    const name = this.prefix(key) + profile;
    invalidateDevices();
    let udid = (await this.platform.list()).find(
      (device) => device.name === name,
    )?.udid;
    if (!udid) {
      udid = await this.platform.create(
        name,
        template.deviceTypeIdentifier,
        template.runtimeIdentifier,
      );
      if (!identifier.test(udid))
        throw new Error("Simulator creation did not return a device ID");
      invalidateDevices();
    }
    const assignment = { udid, name, template };
    this.state.current[key] = assignment;
    await this.save();
    return assignment;
  }
  async stop(assignment: Assignment) {
    invalidateDevices();
    const device = (await this.platform.list()).find(
      (item) => item.udid === assignment.udid && item.name === assignment.name,
    );
    if (!device || device.state === "Shutdown") return;
    try {
      await this.platform.shutdown(assignment.udid);
    } catch (error) {
      const remaining = (await this.platform.list()).find(
        (item) => item.udid === assignment.udid,
      );
      if (remaining && remaining.state !== "Shutdown") throw error;
    }
    invalidateDevices();
  }
  async close() {
    await this.writes;
    if (this.locked) {
      this.locked = false;
      await unlink(this.lock);
    }
  }
}

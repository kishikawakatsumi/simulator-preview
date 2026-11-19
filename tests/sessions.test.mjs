import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sessionKey, ManagedDevices } from "../dist/server/assignments.js";
import { SessionPool } from "../dist/server/sessions.js";
import { readConfig } from "../dist/server/config.js";
import {
  clientIdentity,
  workspaceIdentity,
  additionalWorkspaceURL,
} from "../dist/web/client-identity.js";

const template = {
  udid: randomUUID(),
  name: "iPhone",
  state: "Shutdown",
  runtime: "26.2",
  deviceTypeIdentifier: "phone",
  runtimeIdentifier: "ios26",
};
class Host extends EventEmitter {
  status = {
    type: "status",
    ready: false,
    connected: false,
    busy: false,
    switching: false,
    revision: 0,
    width: 0,
    height: 0,
    device: "",
    supportsHinge: false,
    error: "",
  };
  commands = [];
  stopped = false;
  start(config) {
    this.config = config;
    if (config.device) this.select(config.device);
  }
  select(udid) {
    this.status = {
      ...this.status,
      udid,
      ready: true,
      connected: true,
      revision: this.status.revision + 1,
    };
    this.emit("status", this.status);
  }
  send(command) {
    this.commands.push(command);
    if (command.type === "select-device") this.select(command.udid);
  }
  async stop() {
    this.stopped = true;
  }
}
async function fixture(t, extra = {}) {
  const devices = [];
  const stopped = [];
  const directory = await mkdtemp(path.join(tmpdir(), "studio-assignments-"));
  const platform = {
    async list() {
      return devices;
    },
    async create(name) {
      const udid = randomUUID();
      devices.push({ ...template, udid, name });
      return udid;
    },
    async shutdown(udid) {
      stopped.push(udid);
      devices.find((d) => d.udid === udid).state = "Shutdown";
    },
  };
  const registry = new ManagedDevices(directory, platform);
  const pool = new SessionPool(
    { ...readConfig({}), ...extra },
    {
      devices: registry,
      createHost: () => {
        const host = new Host();
        const select = host.select.bind(host);
        host.select = (udid) => {
          devices.find((device) => device.udid === udid).state = "Booted";
          select(udid);
        };
        return host;
      },
    },
  );
  await pool.ready;
  t.after(() => pool.close());
  return { pool, registry, platform, directory, devices, stopped };
}
const key = (
  user = "alice",
  client = "00000000-0000-4000-8000-000000000001",
  workspace = "main",
) => sessionKey("issuer", user, client, workspace);
const select = async (session, viewer = "tab", model = template) => {
  session.control.receive(viewer, { type: "claim" }, session.status);
  await session.select(viewer, model);
};

test("identity is scoped to authenticated user, browser and optional workspace", () => {
  assert.notEqual(key("alice"), key("bob"));
  assert.notEqual(key(), key("alice", randomUUID()));
  assert.notEqual(
    key(),
    key("alice", "00000000-0000-4000-8000-000000000001", randomUUID()),
  );
  assert.equal(key(), key());
  assert.throws(() => key("alice", "../../other"));
  assert.throws(() => key("alice", randomUUID(), "other"));
  const values = new Map();
  const storage = {
    getItem: (k) => values.get(k),
    setItem: (k, v) => values.set(k, v),
  };
  assert.equal(clientIdentity(storage), clientIdentity(storage));
  assert.doesNotThrow(() =>
    clientIdentity({
      getItem() {
        throw Error();
      },
      setItem() {
        throw Error();
      },
    }),
  );
  const url = new URL("https://studio.example/?x=1");
  const extra = new URL(additionalWorkspaceURL(url));
  assert.notEqual(workspaceIdentity(extra), "main");
  assert.equal(workspaceIdentity(new URL(extra)), workspaceIdentity(extra));
  assert.equal(workspaceIdentity(url), "main");
});

test("two users or client devices get distinct instances of the same model and independent control", async (t) => {
  const { pool, devices } = await fixture(t);
  const [a, b] = await Promise.all([
    pool.acquire(key()),
    pool.acquire(key("bob")),
  ]);
  await Promise.all([select(a), select(b)]);
  assert.equal(devices.length, 2);
  assert.notEqual(a.assignment.udid, b.assignment.udid);
  assert.equal(
    a.status.udid,
    template.udid,
    "client sees model selection, not another instance",
  );
  assert.equal(a.control.owner, "tab");
  assert.equal(b.control.owner, "tab");
  a.control.receive("tab", { type: "action", action: "home" }, a.status);
  assert.equal(a.host.commands.at(-1).action, "home");
  assert.equal(
    b.host.commands.some((c) => c.type === "action"),
    false,
  );
});

test("same browser tabs share their session; additional workspaces do not", async (t) => {
  const { pool } = await fixture(t);
  const [a, tab] = await Promise.all([
    pool.acquire(key()),
    pool.acquire(key()),
  ]);
  assert.equal(a, tab);
  assert.equal(a.references, 2);
  await select(a, "first");
  assert.equal(a.control.receive("second", { type: "claim" }, a.status), true);
  assert.equal(a.control.owner, "second");
  assert.equal(
    a.control.receive("first", { type: "action", action: "home" }, a.status),
    false,
  );
  const separate = await pool.acquire(
    key("alice", "00000000-0000-4000-8000-000000000001", randomUUID()),
  );
  await select(separate, "second");
  assert.notEqual(a.assignment.udid, separate.assignment.udid);
});

test("capacity reservations are atomic, idle sessions are stopped before reuse, active ones are never taken", async (t) => {
  const { pool } = await fixture(t);
  const [a, b, c] = await Promise.all([
    pool.acquire(key()),
    pool.acquire(key("bob")),
    pool.acquire(key("carol")),
  ]);
  assert.ok(a && b);
  assert.equal(c, undefined);
  pool.release(a);
  const next = await pool.acquire(key("carol"));
  assert.equal(a.host.stopped, true);
  assert.equal(b.host.stopped, false);
  assert.ok(next);
  assert.equal(pool.sessions.size, 2);
});

test("disconnect timeout stops the host but retains the device for reconnect and server restart", async (t) => {
  const { pool, registry, platform, directory, devices } = await fixture(t);
  const a = await pool.acquire(key());
  await select(a);
  const udid = a.assignment.udid;
  pool.release(a);
  await pool.sweep(a.idleSince + 60_001);
  assert.equal(a.host.stopped, true);
  const b = await pool.acquire(key());
  assert.equal(b.assignment.udid, udid);
  assert.equal(b.host.config.device, udid);
  assert.equal(devices.length, 1);
  await pool.close();
  const restarted = new ManagedDevices(directory, platform);
  await restarted.initialize();
  t.after(() => restarted.close());
  assert.equal((await restarted.current(key())).udid, udid);
  assert.equal(await restarted.current(key("bob")), undefined);
  assert.ok(
    JSON.parse(await readFile(path.join(directory, "assignments.json"), "utf8"))
      .current[key()],
  );
});

test("slow cleanup does not queue timer retries ahead of a new connection", async (t) => {
  const { pool, platform } = await fixture(t);
  const a = await pool.acquire(key());
  await select(a);
  pool.release(a);
  a.idleSince = Date.now() - 60_001;
  const list = platform.list.bind(platform);
  let began, finish;
  const entered = new Promise((resolve) => {
    began = resolve;
  });
  const delayed = new Promise((resolve) => {
    finish = resolve;
  });
  let attempts = 0;
  platform.list = async () => {
    attempts++;
    began();
    await delayed;
    throw Error("simctl list timed out");
  };
  const first = assert.rejects(pool.sweep(), /simctl list timed out/);
  await entered;
  const retries = Array.from({ length: 20 }, () => pool.sweep());
  const next = pool.acquire(key("bob"));
  finish();
  await first;
  await Promise.all(retries);
  assert.ok(await next);
  assert.equal(
    attempts,
    1,
    "twenty timer ticks must not become twenty more commands",
  );
  assert.equal(
    pool.sessions.size,
    2,
    "failed cleanup still occupies its capacity slot",
  );
  platform.list = list;
});

test("failed cleanup backs off without freeing capacity, then retries successfully", async (t) => {
  const { pool, platform } = await fixture(t);
  const a = await pool.acquire(key());
  await select(a);
  pool.release(a);
  a.idleSince = Date.now() - 60_001;
  const list = platform.list.bind(platform);
  let attempts = 0;
  platform.list = async () => {
    attempts++;
    throw Error("simctl list timed out");
  };
  await assert.rejects(pool.sweep(), /simctl list timed out/);
  await pool.sweep();
  await pool.sweep(Date.now() + 29_000);
  assert.equal(attempts, 1);
  assert.equal(pool.sessions.size, 1);
  await assert.rejects(
    pool.sweep(Date.now() + 31_000),
    /simctl list timed out/,
  );
  assert.equal(attempts, 2);
  platform.list = list;
  await pool.sweep(Date.now() + 62_000);
  assert.equal(pool.sessions.size, 0);
});

test("reselecting a model reuses private data and never boots the template itself", async (t) => {
  const { pool, devices } = await fixture(t);
  const a = await pool.acquire(key());
  await select(a);
  const first = a.assignment.udid;
  await select(a, "tab", {
    ...template,
    udid: randomUUID(),
    deviceTypeIdentifier: "tablet",
  });
  assert.notEqual(a.assignment.udid, first);
  await select(a);
  assert.equal(a.assignment.udid, first);
  assert.equal(devices.length, 2);
  assert.equal(
    a.host.commands.some((c) => c.udid === template.udid),
    false,
  );
});

test("a concurrent model selection cannot allocate two devices for one session", async (t) => {
  const { pool, devices } = await fixture(t);
  const a = await pool.acquire(key());
  a.control.receive("tab", { type: "claim" }, a.status);
  await Promise.all([
    a.select("tab", template),
    a.select("tab", {
      ...template,
      udid: randomUUID(),
      deviceTypeIdentifier: "tablet",
    }),
  ]);
  assert.equal(devices.length, 1);
});

test("crash recovery stops only this installation; a second server cannot share its state directory", async (t) => {
  const { registry, directory, platform, pool, devices, stopped } =
    await fixture(t);
  const second = new ManagedDevices(directory, platform);
  await assert.rejects(second.initialize(), /EEXIST/);
  const own = await registry.provision(key(), template);
  await pool.close();
  devices[0].state = "Booted";
  devices.push({
    ...template,
    udid: randomUUID(),
    name: "Studio-other-installation",
    state: "Booted",
  });
  await second.initialize();
  t.after(() => second.close());
  assert.deepEqual(stopped, [own.udid]);
  assert.equal(devices[1].state, "Booted");
});

test("switching back waits for the previous shutdown before restarting that device", async (t) => {
  const { pool, platform, devices } = await fixture(t);
  const a = await pool.acquire(key());
  await select(a);
  const original = a.assignment.udid;
  const shutdown = platform.shutdown.bind(platform);
  let unblock;
  platform.shutdown = async (udid) => {
    if (udid === original)
      await new Promise((resolve) => {
        unblock = resolve;
      });
    await shutdown(udid);
  };
  await select(a, "tab", {
    ...template,
    udid: randomUUID(),
    deviceTypeIdentifier: "tablet",
  });
  await new Promise(setImmediate);
  const returning = select(a);
  await new Promise(setImmediate);
  assert.notEqual(a.assignment.udid, original);
  unblock();
  await returning;
  platform.shutdown = shutdown;
  assert.equal(a.assignment.udid, original);
  assert.equal(devices.find((d) => d.udid === original).state, "Booted");
});

test("a failed shutdown does not free capacity while its simulator may still be running", async (t) => {
  const { pool, platform } = await fixture(t, { maxSessions: 1 });
  const a = await pool.acquire(key());
  await select(a);
  pool.release(a);
  const shutdown = platform.shutdown.bind(platform);
  platform.shutdown = async () => {
    throw Error("Shutdown failed");
  };
  await assert.rejects(pool.acquire(key("bob")), /Shutdown failed/);
  assert.equal(pool.sessions.size, 1);
  platform.shutdown = shutdown;
  assert.ok(await pool.acquire(key("bob")));
  assert.equal(pool.sessions.size, 1);
});

test("native failures expose a stable reference, keep diagnostics on the host, and clear on recovery", async (t) => {
  const logs = t.mock.method(console, "error", () => {});
  const { pool } = await fixture(t);
  const session = await pool.acquire(key());
  await select(session);
  const raw = "LaunchServicesMigrator /private/host-path\n".repeat(1000);
  session.host.status = {
    ...session.host.status,
    connected: false,
    ready: false,
    error: raw,
  };
  session.host.emit("status", session.host.status);
  const publicError = session.status.error;
  assert.match(publicError, /Reference: [a-f0-9]{8}\.$/);
  assert.ok(publicError.length < 200);
  assert.ok(!publicError.includes("LaunchServicesMigrator"));
  session.host.emit("status", session.host.status);
  assert.equal(session.status.error, publicError);
  assert.equal(logs.mock.callCount(), 1);
  assert.equal(logs.mock.calls[0].arguments[1], raw);
  session.host.status = {
    ...session.host.status,
    connected: true,
    ready: true,
    error: "",
  };
  session.host.emit("status", session.host.status);
  assert.equal(session.status.error, "");
});

test("provisioning failures remain readable on reconnect and can be retried", async (t) => {
  t.mock.method(console, "error", () => {});
  const { pool, platform } = await fixture(t);
  const session = await pool.acquire(key());
  const create = platform.create;
  platform.create = async () => {
    throw Error("simctl failed: private diagnostic output");
  };
  await select(session);
  const failure = session.status.error;
  assert.match(failure, /Reference:/);
  assert.equal(session.status.switching, false);
  assert.equal((await pool.acquire(key())).status.error, failure);
  platform.create = create;
  await select(session);
  assert.equal(session.status.error, "");
  assert.equal(session.status.connected, true);
});

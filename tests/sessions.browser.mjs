import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import rtc from "node-datachannel";
import { createStudio } from "../dist/server/server.js";
import { readConfig } from "../dist/server/config.js";
import { SimulatorHost } from "../dist/server/host.js";
import { listDevices } from "../dist/server/devices.js";
import { sessionKey } from "../dist/server/assignments.js";

const real = process.env.PREVIEW_TEMPLATE;
const stateDirectory = await mkdtemp("/private/tmp/studio-multiple-state-");
const config = readConfig({
  PREVIEW_PORT: "19094",
  PREVIEW_ORIGIN: "http://127.0.0.1:19094",
  PREVIEW_AUTH: "local",
  PREVIEW_TEST_PATTERN: real ? "0" : "1",
  PREVIEW_STATE_DIR: stateDirectory,
  PREVIEW_APP_PATH: process.env.PREVIEW_APP_PATH,
  PREVIEW_MAX_SESSIONS: "2",
  PREVIEW_MAX_VIEWERS: "8",
  PREVIEW_SESSION_IDLE_SECONDS: "5",
});
const template = real
  ? (await listDevices()).find((d) => d.udid === real)
  : undefined;
if (real && !template) throw Error("Template not found");
const commands = new Map();
const studio = createStudio(config, {
  // Test identities stand in for already-verified Access JWTs. Production always verifies JWTs.
  authenticate: async (request) => ({
    id: request.headers["x-test-user"] ?? "alice",
    name: request.headers["x-test-user"] ?? "alice",
    expiresAt: Date.now() + 3600_000,
  }),
  ...(real ? { listDevices: async () => [template] } : {}),
  createHost() {
    const host = new SimulatorHost();
    const log = [];
    commands.set(host, log);
    const send = host.send.bind(host);
    host.send = (command) => {
      log.push(command);
      send(command);
    };
    return host;
  },
});
await studio.ready;
studio.server.listen(config.port, "127.0.0.1");
await once(studio.server, "listening");
let browser;
const errors = [];
const clientA = randomUUID(),
  clientB = randomUUID();
const key = (user, client, workspace = "main") =>
  sessionKey("local", user, client, workspace);
const session = (user, client, workspace) =>
  studio.pool.sessions.get(key(user, client, workspace));
const until = async (fn) => {
  for (let i = 0; i < 1200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(fn());
};
const ready = async (page) => {
  await page.waitForFunction(
    () =>
      document.body.dataset.state === "connected" &&
      document.body.dataset.control === "owner" &&
      !document.querySelector('[data-action="home"]').disabled,
    {},
    { timeout: real ? 180_000 : 30_000 },
  );
};
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  async function context(user, client) {
    const context = await browser.newContext({
      extraHTTPHeaders: { "x-test-user": user },
      viewport: { width: 1100, height: 1000 },
    });
    await context.addInitScript((client) => {
      try {
        localStorage.setItem("simulator-preview.client", client);
      } catch {
        /* about:blank has no storage */
      }
      const Peer = RTCPeerConnection;
      window.RTCPeerConnection = class extends Peer {
        constructor(...args) {
          super(...args);
          this.addEventListener("datachannel", (event) => {
            window.testChannel = event.channel;
          });
        }
      };
    }, client);
    context.on("page", (page) =>
      page.on("pageerror", (error) => errors.push(error.message)),
    );
    return context;
  }
  const first = await context("alice", clientA),
    second = await context("alice", clientB);
  const a = await first.newPage(),
    b = await second.newPage();
  await a.goto(config.origin);
  await ready(a);
  await b.goto(config.origin);
  await ready(b);
  const sa = session("alice", clientA),
    sb = session("alice", clientB);
  assert.notEqual(sa.host, sb.host);
  if (real) {
    assert.notEqual(sa.assignment.udid, sb.assignment.udid);
    assert.notEqual(sa.assignment.udid, real);
    assert.notEqual(sb.assignment.udid, real);
    console.log("Private simulators:", sa.assignment.udid, sb.assignment.udid);
  }
  // Independent control and media: a status/stream interruption must not leak to the other session.
  const beforeB = commands
    .get(sb.host)
    .filter((c) => c.type === "pointer").length;
  await a.locator("video").click({ position: { x: 250, y: 300 } });
  await until(() => commands.get(sa.host).some((c) => c.type === "pointer"));
  assert.equal(
    commands.get(sb.host).filter((c) => c.type === "pointer").length,
    beforeB,
  );
  const aCommands = commands.get(sa.host).length;
  await b.click('[data-action="home"]');
  await until(() =>
    commands
      .get(sb.host)
      .some((c) => c.type === "action" && c.action === "home"),
  );
  assert.equal(
    commands
      .get(sa.host)
      .slice(aCommands)
      .some((c) => c.type === "action"),
    false,
  );
  if (real) {
    const selectedB = sb.assignment.udid;
    await b.evaluate(
      (udid) =>
        window.testChannel.send(
          JSON.stringify({ type: "select-device", udid }),
        ),
      sa.assignment.udid,
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      sb.assignment.udid,
      selectedB,
      "cannot select another private instance",
    );
  }
  await a.reload();
  await ready(a);
  assert.equal(session("alice", clientA), sa);
  const tab = await first.newPage();
  await tab.goto(config.origin);
  await tab.waitForFunction(() => document.body.dataset.state === "connected");
  await tab.evaluate(() => dispatchEvent(new Event("focus")));
  await tab.waitForFunction(() => document.body.dataset.control === "owner");
  await a.waitForFunction(() => document.body.dataset.control !== "owner");
  assert.equal(await tab.locator("#claim").count(), 0);
  await a.evaluate(() => dispatchEvent(new Event("focus")));
  await a.waitForFunction(() => document.body.dataset.control === "owner");
  await tab.waitForFunction(() => document.body.dataset.control === "viewer");
  await tab.close();

  if (real) {
    const ids = [sa.assignment.udid, sb.assignment.udid];
    await a.close();
    await b.close();
    await until(() => studio.pool.sessions.size === 0);
    const resumed = await first.newPage();
    await resumed.goto(config.origin);
    await ready(resumed);
    assert.equal(session("alice", clientA).assignment.udid, ids[0]);
    await resumed.close();
    await until(() => studio.pool.sessions.size === 0);
    console.log(
      "PASS: two actual private iOS simulators of the same model, separate WebRTC/input, rejected cross-instance selection, idle shutdown and resume.",
    );
  } else {
    // Same client ID under a different verified user must never join Alice's session.
    const third = await context("bob", clientA),
      c = await third.newPage();
    await c.goto(config.origin);
    await c.waitForFunction(() => document.body.dataset.state === "waiting");
    assert.equal(session("bob", clientA), undefined);
    const restoredUDID = sa.assignment?.udid;
    await a.close();
    await ready(c);
    assert.equal(studio.pool.sessions.has(sa.key), false);
    assert.notEqual(session("bob", clientA).host, sa.host);
    if (real)
      assert.notEqual(session("bob", clientA).assignment.udid, restoredUDID);
    await c.close();
    const resumed = await first.newPage();
    await resumed.goto(config.origin);
    await ready(resumed);
    if (real)
      assert.equal(session("alice", clientA).assignment.udid, restoredUDID);

    // Explicit extra workspace has a new URL, survives reload and gets a separate simulator.
    await b.close();
    const popupPromise = first.waitForEvent("page");
    await resumed.click("#additional-workspace");
    const extra = await popupPromise;
    await ready(extra);
    const workspace = new URL(extra.url()).searchParams.get("workspace");
    assert.ok(workspace);
    assert.notEqual(
      session("alice", clientA, workspace),
      session("alice", clientA),
    );
    const extraHost = session("alice", clientA, workspace).host;
    await extra.reload();
    await ready(extra);
    assert.equal(session("alice", clientA, workspace).host, extraHost);
    await extra.close();
    await resumed.close();
    await until(() => studio.pool.sessions.size === 0);
  }
  assert.deepEqual(errors, []);
  if (!real)
    console.log(
      "PASS: independent clients, same-browser tabs, user isolation, capacity/wait/retry, preserved reconnect, extra workspace, idle shutdown.",
    );
  if (real) {
    const state = JSON.parse(
      await readFile(stateDirectory + "/assignments.json", "utf8"),
    );
    await writeFile(
      stateDirectory + "/test-result.json",
      JSON.stringify({ assignments: state.current, passed: true }, null, 2),
    );
    console.log("State/results:", stateDirectory);
  }
} finally {
  await browser?.close();
  await studio.close();
  rtc.cleanup();
  if (real) {
    const state = JSON.parse(
      await readFile(stateDirectory + "/assignments.json", "utf8"),
    );
    const data = JSON.parse(
      execFileSync("xcrun", ["simctl", "list", "devices", "--json"], {
        encoding: "utf8",
      }),
    );
    for (const device of Object.values(data.devices).flat()) {
      if (device.name.startsWith(`Studio-${state.installation}-`))
        execFileSync("xcrun", ["simctl", "delete", device.udid]);
    }
    console.log("Removed test-only simulators.");
  }
}

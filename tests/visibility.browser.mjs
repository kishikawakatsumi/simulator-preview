import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { chromium } from "playwright";
import rtc from "node-datachannel";
import { readConfig } from "../dist/server/config.js";
import { createStudio } from "../dist/server/server.js";
import { SimulatorHost } from "../dist/server/host.js";

// Real encoding and WebRTC; only page visibility/focus are simulated.
const config = readConfig({
  PREVIEW_PORT: "19095",
  PREVIEW_ORIGIN: "http://127.0.0.1:19095",
  PREVIEW_AUTH: "local",
  PREVIEW_TEST_PATTERN: "1",
  PREVIEW_STATE_DIR: await mkdtemp("/private/tmp/studio-visibility-state-"),
});
const commands = [];
let frames = 0;
const studio = createStudio(config, {
  createHost() {
    const host = new SimulatorHost();
    host.on("frame", () => frames++);
    const send = host.send.bind(host);
    host.send = (command) => {
      commands.push(command);
      send(command);
    };
    return host;
  },
});
await studio.ready;
studio.server.listen(config.port, "127.0.0.1");
await once(studio.server, "listening");
const until = async (predicate) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(predicate(), "condition timed out");
};
const streamEnabled = () =>
  commands.findLast((c) => c.type === "stream")?.enabled === true;
const setVisible = (page, visible) =>
  page.evaluate((visible) => {
    window.testVisible = visible;
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);
const ready = (page) =>
  page.waitForFunction(
    () =>
      document.body.dataset.control === "owner" &&
      !document.querySelector('[data-action="home"]').disabled &&
      !document.querySelector("#screen").paused &&
      document.querySelector("#screen").classList.contains("visible"),
  );
const bytes = (page) =>
  page.evaluate(async () => {
    const stats = await window.testPeer.getStats();
    let received = 0;
    stats.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video")
        received += s.bytesReceived;
    });
    return received;
  });
let browser;
const errors = [];
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.testVisible = false;
    window.sent = [];
    Object.defineProperty(document, "hidden", {
      get: () => !window.testVisible,
    });
    document.hasFocus = () => window.testVisible;
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (message) {
      window.sent.push(JSON.parse(message));
      window.testChannel = this;
      return send.call(this, message);
    };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) {
        super(...args);
        window.testPeer = this;
      }
    };
  });
  const a = await context.newPage();
  a.on("pageerror", (e) => errors.push(e.message));
  let sockets = 0;
  a.on("websocket", () => sockets++);
  await a.goto(config.origin);
  await a.waitForFunction(() => document.body.dataset.state === "connected");
  await a.waitForTimeout(500);
  assert.equal(
    frames,
    0,
    "a connection opened in the background must not start encoding",
  );
  assert.equal(streamEnabled(), false);
  await setVisible(a, true);
  await ready(a);
  await until(() => frames > 10);

  // Count actual UI writes while the hardware encoder supplies a continuous stream.
  await a.evaluate(() => {
    window.uiWrites = 0;
    window.resolutionWrites = 0;
    window.uiObserver = new MutationObserver(
      (records) => (window.uiWrites += records.length),
    );
    window.uiObserver.observe(document.querySelector("#owner"), {
      childList: true,
    });
    window.resolutionObserver = new MutationObserver(
      (records) => (window.resolutionWrites += records.length),
    );
    window.resolutionObserver.observe(document.querySelector("#resolution"), {
      childList: true,
    });
  });
  const startFrames = frames;
  await a.waitForTimeout(1500);
  const writes = await a.evaluate(() => {
    window.uiObserver.disconnect();
    window.resolutionObserver.disconnect();
    return { controls: window.uiWrites, resolution: window.resolutionWrites };
  });
  assert.ok(frames - startFrames >= 15);
  assert.ok(writes.controls < 10, JSON.stringify(writes));
  assert.equal(writes.resolution, 0);
  console.log("UI writes in 1.5 seconds:", {
    encodedFrames: frames - startFrames,
    ...writes,
  });

  const b = await context.newPage();
  b.on("pageerror", (e) => errors.push(e.message));
  b.on("websocket", () => sockets++);
  await b.goto(config.origin);
  await b.waitForFunction(() => document.body.dataset.state === "connected");
  assert.equal(
    studio.pool.sessions.size,
    1,
    "both tabs share their private simulator",
  );
  await setVisible(b, true);
  await ready(b);
  await setVisible(a, false);
  await a.waitForTimeout(500); // Drain any already-sent video packets.
  const aBytes = await bytes(a),
    bBytes = await bytes(b);
  const activeFrames = frames;
  await b.waitForTimeout(1200);
  assert.equal(
    await bytes(a),
    aBytes,
    "hidden tab receives no video while another tab watches",
  );
  assert.ok((await bytes(b)) > bBytes);
  assert.ok(frames > activeFrames);
  assert.equal(streamEnabled(), true);

  await setVisible(b, false);
  await until(() => !streamEnabled());
  await b.waitForTimeout(500);
  const idleFrames = frames;
  const keyframes = commands.filter((c) => c.type === "keyframe").length;
  const sentBefore = await b.evaluate(
    () =>
      window.sent.filter((c) => ["keyframe", "quality"].includes(c.type))
        .length,
  );
  // A late/misbehaving hidden receiver cannot restart encoding or lower the active bitrate.
  await a.evaluate(() => {
    window.testChannel.send(JSON.stringify({ type: "keyframe" }));
    window.testChannel.send(
      JSON.stringify({ type: "quality", loss: 1, delay: 1 }),
    );
  });
  await b.waitForTimeout(5000); // Includes the four-second stall watchdog and stats polling.
  assert.equal(
    frames,
    idleFrames,
    "zero newly encoded frames while all tabs are hidden",
  );
  assert.equal(commands.filter((c) => c.type === "keyframe").length, keyframes);
  assert.equal(
    await b.evaluate(
      () =>
        window.sent.filter((c) => ["keyframe", "quality"].includes(c.type))
          .length,
    ),
    sentBefore,
  );
  assert.equal(
    [...studio.pool.sessions.values()][0].lastBitrate,
    config.bitrate,
  );
  assert.equal(await b.locator("video").evaluate((v) => v.paused), true);

  await setVisible(a, true);
  await ready(a);
  await until(() => frames > idleFrames + 5);
  assert.equal(streamEnabled(), true);
  await a.close();
  await until(() => !streamEnabled());
  await setVisible(b, true);
  await ready(b);
  const resumedBytes = await bytes(b);
  await b.waitForTimeout(500);
  assert.ok((await bytes(b)) > resumedBytes);
  assert.equal(
    sockets,
    2,
    "visibility resumes the existing peer rather than reconnecting",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: hidden startup, per-tab delivery, all-hidden encoder stop, no hidden recovery requests, close-active-tab stop, automatic video/control resume, and state-driven UI updates.",
  );
} finally {
  await browser?.close();
  await studio.close();
  rtc.cleanup();
}

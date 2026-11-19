import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { once } from "node:events";
import { chromium } from "playwright";
import rtc from "node-datachannel";
import { readConfig } from "../dist/server/config.js";
import { createStudio } from "../dist/server/server.js";
import { SimulatorHost } from "../dist/server/host.js";

const stateDirectory = await mkdtemp("/private/tmp/studio-browser-state-");
const config = readConfig({
  PREVIEW_STATE_DIR: stateDirectory,
  ...process.env,
  PREVIEW_PORT: "19090",
  PREVIEW_ORIGIN: "http://127.0.0.1:19090",
  PREVIEW_AUTH: "local",
  PREVIEW_TEST_PATTERN: process.env.PREVIEW_DEVICE ? "0" : "1",
  PREVIEW_HOST_PATH:
    process.env.PREVIEW_HOST_PATH ?? "dist/native/SimulatorHost",
});
let host;
const studio = createStudio(config, {
  createHost() {
    host = new SimulatorHost();
    return host;
  },
});
rtc.initLogger("Error", (_level, message) => console.error(message));
await studio.ready;
studio.server.listen(config.port, "127.0.0.1");
await once(studio.server, "listening");
let browser;
const errors = [];
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) =>
    socket.on("framereceived", (event) => {
      const message = JSON.parse(event.payload.toString());
      if (["connection", "error"].includes(message.type))
        console.log("Signal:", message);
    }),
  );
  if (process.env.PREVIEW_TEST_PICKER) {
    await page.route("**/api/devices", async (route) => {
      const response = await route.fetch();
      const { devices } = await response.json();
      await route.fulfill({
        json: {
          devices: devices.filter((device) => device.udid === config.device),
        },
      });
    });
  }
  await page.goto(config.origin);
  await page.waitForFunction(
    () => document.body.dataset.state === "connected",
    {},
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () =>
      document.querySelector("video").videoWidth > 100 &&
      document.querySelector("video").classList.contains("visible"),
    {},
    { timeout: config.testPattern ? 15000 : 90000 },
  );
  await page.waitForFunction(() => document.body.dataset.control === "owner");
  await page.waitForFunction(
    () => !document.querySelector('[data-action="home"]').disabled,
    {},
    { timeout: 15000 },
  );
  await page.waitForFunction(
    () => Number(document.querySelector("#fps").textContent) > 0,
    {},
    { timeout: 15000 },
  );
  assert.equal(await page.locator("header, footer, #viewers").count(), 0);
  assert.equal(
    await page.locator("#refresh").getAttribute("aria-label"),
    "Refresh device list",
  );
  if (process.env.PREVIEW_TEST_PICKER)
    assert.equal(await page.locator("#device").inputValue(), config.device);
  assert.equal(await page.locator("#claim").count(), 0);
  await page.evaluate(() => {
    window.testHidden = true;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => window.testHidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(
    () => document.body.dataset.control === "available",
  );
  await page.waitForTimeout(500);
  assert.equal(
    await page.locator("body").getAttribute("data-control"),
    "available",
  );
  await page.evaluate(() => {
    window.testHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => document.body.dataset.control === "owner");
  const probe = process.env.PREVIEW_PROBE;
  let probeDirectory;
  const ready = async () =>
    page.waitForFunction(
      () => !document.querySelector('[data-action="home"]').disabled,
    );
  async function point(x, y) {
    const rect = await page.locator("video").evaluate((video) => {
      const box = video.getBoundingClientRect();
      const scale = Math.min(
        box.width / video.videoWidth,
        box.height / video.videoHeight,
      );
      return {
        x: box.x + (box.width - video.videoWidth * scale) / 2,
        y: box.y + (box.height - video.videoHeight * scale) / 2,
        width: video.videoWidth * scale,
        height: video.videoHeight * scale,
      };
    });
    return { x: rect.x + rect.width * x, y: rect.y + rect.height * y };
  }
  async function tap(x, y) {
    const p = await point(x, y);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(250);
  }
  if (probe) {
    probeDirectory = execFileSync(
      "xcrun",
      ["simctl", "get_app_container", host.status.udid, probe, "data"],
      { encoding: "utf8" },
    ).trim();
    await tap(0.25, 0.35);
    let p = await point(0.65, 0.35);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.waitForTimeout(750);
    await page.mouse.up();
    p = await point(0.25, 0.7);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    p = await point(0.75, 0.4);
    await page.mouse.move(p.x, p.y, { steps: 12 });
    await page.mouse.up();
    await page.click('[data-action="right"]');
    await page.waitForFunction(
      () =>
        document.querySelector("video").videoWidth >
        document.querySelector("video").videoHeight,
    );
    await ready();
    await tap(0.25, 0.35);
    await page.click('[data-action="left"]');
    await page.waitForFunction(
      () =>
        document.querySelector("video").videoWidth <
        document.querySelector("video").videoHeight,
    );
    await ready();
  }
  const client = await page.evaluate(() =>
    localStorage.getItem("simulator-preview.client"),
  );
  const viewer = await browser.newPage({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await viewer.addInitScript((client) => {
    document.hasFocus = () => false; // Open initially as a passive tab.
    try {
      localStorage.setItem("simulator-preview.client", client);
    } catch {}
  }, client);
  if (process.env.PREVIEW_TEST_PICKER) {
    await viewer.route("**/api/devices", async (route) => {
      const response = await route.fetch();
      const { devices } = await response.json();
      await route.fulfill({
        json: {
          devices: devices.filter((device) => device.udid === config.device),
        },
      });
    });
  }
  viewer.on("pageerror", (error) => errors.push(error.message));
  await viewer.goto(config.origin);
  await viewer.waitForFunction(
    () =>
      document.querySelector("video").videoWidth > 0 &&
      document.body.dataset.control === "viewer",
    {},
    { timeout: 30000 },
  );
  assert.equal(await viewer.locator("#claim").count(), 0);
  assert.equal(await viewer.locator('[data-action="home"]').isDisabled(), true);
  for (const selector of [
    '[data-action="home"]',
    '[data-action="left"]',
    '[data-action="right"]',
    "#fullscreen",
  ]) {
    assert.equal(
      await viewer.locator(`${selector} .button-label`).isVisible(),
      false,
    );
    assert.ok(await viewer.locator(selector).getAttribute("aria-label"));
    const box = await viewer.locator(selector).boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44);
  }
  assert.equal(
    await viewer.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await mkdir(".artifacts", { recursive: true });
  await page.screenshot({ path: ".artifacts/desktop.png", fullPage: true });
  await viewer.screenshot({ path: ".artifacts/mobile.png", fullPage: true });
  await viewer.setViewportSize({ width: 844, height: 390 });
  assert.equal(
    await viewer.locator("#fullscreen .button-label").isVisible(),
    false,
  );
  assert.equal(
    await viewer.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await viewer.screenshot({
    path: ".artifacts/mobile-landscape.png",
    fullPage: true,
  });
  await viewer.setViewportSize({ width: 390, height: 844 });
  console.log("Metrics:", await page.locator(".metrics").innerText());
  await page.click("#fullscreen");
  assert.equal(
    await page.locator("body").evaluate((e) => e.classList.contains("focus")),
    true,
  );
  await page.click("#exit-focus");
  if (probe) {
    const p = await point(0.5, 0.5);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.waitForTimeout(100);
  }
  await page.close();
  await viewer.waitForFunction(() => document.body.dataset.control === "owner");
  if (probe) {
    await viewer.waitForFunction(
      () => !document.querySelector('[data-action="home"]').disabled,
    );
    await viewer.click('[data-action="home"]');
    let state;
    for (let i = 0; i < 50; i++) {
      state = JSON.parse(
        await readFile(path.join(probeDirectory, "Documents/home-state.json")),
      );
      if (state.state === "background") break;
      await viewer.waitForTimeout(100);
    }
    assert.equal(state.state, "background");
    const events = JSON.parse(
      await readFile(path.join(probeDirectory, "Documents/events.json")),
    );
    await writeFile(
      ".artifacts/input-events.json",
      JSON.stringify(events, null, 2),
    );
    const gestures = [];
    for (const event of events) {
      if (event.phase === "began") gestures.push([]);
      gestures.at(-1).push(event);
    }
    assert.equal(gestures.length, 5, JSON.stringify(gestures));
    for (const gesture of gestures) assert.equal(gesture.at(-1).phase, "ended");
    for (const i of [0, 3]) {
      assert.ok(Math.abs(gestures[i][0].x - 0.25) < 0.03);
      assert.ok(Math.abs(gestures[i][0].y - 0.35) < 0.03);
    }
    assert.ok(gestures[1].at(-1).time - gestures[1][0].time > 0.65);
    assert.ok(gestures[2].some((event) => event.phase === "moved"));
    assert.ok(Math.abs(gestures[2].at(-1).x - 0.75) < 0.03);
    assert.equal(gestures[3][0].orientation, 4);
    console.log(
      "PASS: iOS received tap, long press, drag, rotated coordinates, disconnect release and Home.",
    );
  }
  await viewer.reload();
  await viewer.waitForFunction(
    () =>
      document.body.dataset.state === "connected" &&
      document.body.dataset.control === "owner" &&
      document.querySelector("video").videoWidth > 0,
  );
  await viewer.waitForFunction(
    () => !document.querySelector('[data-action="home"]').disabled,
  );
  if (process.env.PREVIEW_TEST_PICKER) {
    await viewer.waitForFunction(
      () => document.querySelector("#device").options.length > 1,
    );
    assert.equal(await viewer.locator("#device").inputValue(), config.device);
    assert.notEqual(
      host.status.udid,
      config.device,
      "user gets a private simulator, not the template",
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: hardware H.264 → WebRTC → browser decode, frame timing, automatic startup/control, two tabs, background/resume, automatic ownership transfer, reload, fullscreen, mobile icons/layout.",
  );
} catch (error) {
  console.error("Host status:", host?.status);
  if (browser)
    for (const context of browser.contexts())
      for (const page of context.pages())
        console.error(
          "Page:",
          await page
            .locator("body")
            .innerText()
            .catch(() => "closed"),
        );
  throw error;
} finally {
  await browser?.close();
  await studio.close();
  rtc.cleanup();
  if (!config.testPattern) {
    const state = JSON.parse(
      await readFile(path.join(stateDirectory, "assignments.json"), "utf8"),
    );
    const devices = JSON.parse(
      execFileSync("xcrun", ["simctl", "list", "devices", "--json"], {
        encoding: "utf8",
      }),
    );
    for (const device of Object.values(devices.devices).flat())
      if (device.name.startsWith(`Studio-${state.installation}-`))
        execFileSync("xcrun", ["simctl", "delete", device.udid]);
  }
}

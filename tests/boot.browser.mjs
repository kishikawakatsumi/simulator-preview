import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import rtc from "node-datachannel";
import { createStudio } from "../dist/server/server.js";
import { readConfig } from "../dist/server/config.js";
import { SimulatorHost } from "../dist/server/host.js";

// A disposable device: never boot, erase or delete an existing user's simulator.
const exec = promisify(execFile);
const simctl = async (...args) =>
  (await exec("xcrun", ["simctl", ...args], { timeout: 180000 })).stdout.trim();
const udid = await simctl(
  "create",
  `StudioBootTest-${randomUUID()}`,
  "com.apple.CoreSimulator.SimDeviceType.iPhone-Air",
  process.env.PREVIEW_BOOT_RUNTIME ??
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
);
console.log("Created disposable boot test device:", udid);
const template = {
  udid,
  name: "iPhone Air",
  runtime: "26.3",
  state: "Shutdown",
  family: "iPhone",
  display: { width: 1260, height: 2736, scale: 3 },
};
const assignment = { udid, name: template.name, template };
const config = readConfig({
  PREVIEW_PORT: "19096",
  PREVIEW_ORIGIN: "http://127.0.0.1:19096",
  PREVIEW_AUTH: "local",
});
const statuses = [],
  commands = [];
let previewFrames = 0;
let browser, studio;
try {
  studio = createStudio(config, {
    listDevices: async () => [template],
    devices: {
      initialize: async () => {},
      current: async () => undefined,
      provision: async () => assignment,
      stop: async () => {},
      close: async () => {},
    },
    createHost() {
      const host = new SimulatorHost();
      const send = host.send.bind(host);
      host.send = (command) => {
        commands.push(command);
        send(command);
      };
      host.on("status", (status) => {
        if (status.error) console.error("Host error:", status.error);
        if (
          !statuses.length ||
          status.preview !== statuses.at(-1).preview ||
          status.ready !== statuses.at(-1).ready
        )
          console.log("Boot state:", {
            preview: status.preview,
            ready: status.ready,
            switching: status.switching,
          });
        statuses.push(status);
      });
      host.on("frame", () => {
        if (host.status.preview && !host.status.ready) previewFrames++;
      });
      return host;
    },
  });
  await studio.ready;
  studio.server.listen(config.port, "127.0.0.1");
  await once(studio.server, "listening");
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 420, height: 844 },
    screen: { width: 420, height: 912 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 Version/27.2 Mobile/15E148 Safari/604.1",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { get: () => true });
    HTMLElement.prototype.requestFullscreen = () =>
      Promise.reject(Error("Standalone fallback"));
  });
  await page.goto(config.origin);
  await page.waitForFunction(
    () =>
      document.querySelector("#placeholder").hidden &&
      document.querySelector("#screen").classList.contains("visible") &&
      document.querySelector('[data-action="home"]').disabled,
    null,
    { timeout: 600000 },
  );
  assert.ok(previewFrames > 0, "real H264 frames arrive before boot completes");
  assert.ok(!statuses.at(-1).ready);
  await mkdir(".artifacts", { recursive: true });
  await page.screenshot({ path: ".artifacts/boot-preview-0.png" });
  const pointers = () => commands.filter((c) => c.type === "pointer").length;
  const before = pointers();
  await page.touchscreen.tap(200, 300);
  await page.click("#focus-menu");
  assert.equal(
    await page.locator('[data-palette-action="home"]').isDisabled(),
    true,
  );
  assert.equal(await page.locator("#palette-exit").isEnabled(), true);
  await page.screenshot({ path: ".artifacts/boot-menu.png" });
  await page.touchscreen.tap(200, 400);
  assert.equal(
    pointers(),
    before,
    "preview taps and menu dismiss must not reach iOS",
  );
  for (let i = 1; i <= 5 && !statuses.at(-1).ready; i++) {
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `.artifacts/boot-preview-${i}.png` });
  }
  await page.waitForFunction(
    () => !document.querySelector('[data-action="home"]').disabled,
    null,
    {
      timeout: 660000,
    },
  );
  assert.ok(statuses.some((s) => s.preview && !s.ready && !s.connected));
  await page.click("#focus-menu");
  await page.click('[data-palette-action="home"]');
  await page.waitForFunction(
    () => document.querySelector("#focus-palette").hidden,
  );
  assert.ok(commands.some((c) => c.type === "action" && c.action === "home"));
  await page.screenshot({ path: ".artifacts/boot-complete.png" });
  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${previewFrames} real startup frames before readiness; boot input denied; menu Home enabled after boot.`,
  );
} finally {
  await browser?.close();
  await studio?.close();
  rtc.cleanup();
  await simctl("shutdown", udid).catch(() => {});
  await simctl("delete", udid);
  console.log("Removed disposable boot test device:", udid);
}

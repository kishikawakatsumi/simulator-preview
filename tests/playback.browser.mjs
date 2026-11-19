import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import rtc from "node-datachannel";
import { readConfig } from "../dist/server/config.js";
import { createStudio } from "../dist/server/server.js";

// Exercise browser policy edge cases with actual H.264/WebRTC, without booting an iOS device.
const config = readConfig({
  PREVIEW_PORT: "19092",
  PREVIEW_ORIGIN: "http://127.0.0.1:19092",
  PREVIEW_AUTH: "local",
  PREVIEW_TEST_PATTERN: "1",
});
const studio = createStudio(config);
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
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  let sockets = 0;
  page.on("websocket", () => sockets++);
  await page.addInitScript(() => {
    window.allowVideoCallbacks = true;
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      const video = this;
      const next = () =>
        original.call(video, (time, metadata) => {
          // Model browsers that only deliver frame callbacks for rendered video.
          if (
            !window.allowVideoCallbacks ||
            getComputedStyle(video).visibility === "hidden"
          )
            next();
          else callback(time, metadata);
        });
      return next();
    };
  });
  if (process.env.PREVIEW_REGRESSION_BASE) {
    for (const asset of ["app.js", "style.css"])
      await page.route(`**/${asset}`, async (route) =>
        route.fulfill({
          contentType: asset.endsWith(".js") ? "text/javascript" : "text/css",
          body: await readFile(
            `${process.env.PREVIEW_REGRESSION_BASE}/dist/web/${asset}`,
          ),
        }),
      );
  }
  await page.goto(config.origin);
  await page.waitForFunction(() => document.body.dataset.control === "owner");
  await page.waitForFunction(
    () => document.querySelector("video").classList.contains("visible"),
    {},
    { timeout: 8000 },
  );
  assert.equal(await page.locator("#placeholder").isVisible(), false);
  console.log(
    "PASS: render-dependent frame callbacks do not deadlock initial playback.",
  );
  const blocked = page;
  // Model a policy that pauses playback and refuses script-only resumes.
  await blocked.evaluate(() => {
    let permitted = false;
    document.addEventListener(
      "click",
      (event) => {
        if (event.isTrusted && event.target.closest("#play-video"))
          permitted = true;
      },
      { capture: true },
    );
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!permitted)
        return Promise.reject(
          new DOMException("A user gesture is required", "NotAllowedError"),
        );
      return original.call(this);
    };
    const video = document.querySelector("video");
    video.pause();
    void video.play().catch(() => {});
  });
  await blocked.locator("#play-video").waitFor({ state: "visible" });
  assert.equal(
    await blocked.locator("#placeholder-title").innerText(),
    "Tap to start video",
  );
  await blocked.click("#play-video");
  await blocked.waitForFunction(
    () =>
      !document.querySelector("video").paused &&
      document.querySelector("#placeholder").hidden,
  );
  assert.equal(await blocked.locator("#placeholder").isVisible(), false);
  assert.equal(sockets, 1, "playback recovery must reuse the current session");
  console.log(
    "PASS: blocked playback offers a tap-to-play recovery without reconnecting.",
  );
  await blocked.close();

  const waiting = await browser.newPage();
  waiting.on("pageerror", (error) => errors.push(error.message));
  // Drive status ordering independently of video delivery. A late data-channel open must not
  // overwrite an already known simulator boot, nor leave that boot label after it completes.
  await waiting.route("**/connection.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export class Connection {
      ready = false;
      constructor() { window.testConnection = this; }
      connect() {
        this.onstate('connecting');
        this.onmessage({ type: 'status', connected: false, ready: false, switching: true, busy: true, device: 'Test phone', revision: 1 });
        this.onmessage({ type: 'control', yours: true, owner: 'me' });
        this.ready = true;
        this.onstate('connected');
      }
      send() { return true; }
      stop() {}
    }`,
    }),
  );
  await waiting.goto(config.origin);
  await waiting.waitForFunction(
    () => document.body.dataset.state === "connected",
  );
  assert.equal(
    await waiting.locator("#placeholder-title").innerText(),
    "Starting simulator…",
  );
  await waiting.evaluate(() =>
    window.testConnection.onmessage({
      type: "status",
      connected: true,
      ready: true,
      switching: false,
      busy: false,
      device: "Test phone",
      revision: 2,
    }),
  );
  assert.equal(
    await waiting.locator("#placeholder-title").innerText(),
    "Waiting for video…",
  );
  await waiting.evaluate(() =>
    window.testConnection.onmessage({
      type: "status",
      connected: false,
      ready: false,
      switching: false,
      busy: false,
      error: "Test boot failed",
      revision: 3,
    }),
  );
  assert.equal(
    await waiting.locator("#placeholder-title").innerText(),
    "Simulator unavailable",
  );
  assert.match(
    await waiting.locator("#placeholder-detail").innerText(),
    /contact the host administrator/,
  );
  assert.ok(
    !(await waiting.locator("body").innerText()).includes("Test boot failed"),
  );
  console.log(
    "PASS: boot, first-video wait and errors remain distinct across event ordering.",
  );
  assert.deepEqual(errors, []);
} catch (error) {
  console.error("Browser errors:", errors);
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages())
      console.error(
        "Page state:",
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
}

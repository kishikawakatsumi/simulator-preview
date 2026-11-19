import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "playwright";
import rtc from "node-datachannel";

// Compare identical synthetic H.264 workloads, not actual iOS simulator capacity.
// PREVIEW_BENCH_BUILD may point at a separate baseline checkout containing dist/.
const build = path.resolve(
  process.env.PREVIEW_BENCH_BUILD ??
    fileURLToPath(new URL("..", import.meta.url)),
);
const load = (file) =>
  import(pathToFileURL(path.join(build, "dist/server", file)).href);
const { readConfig } = await load("config.js");
const { createStudio } = await load("server.js");
const { SimulatorHost } = await load("host.js");
const config = readConfig({
  PREVIEW_PORT: "19096",
  PREVIEW_ORIGIN: "http://127.0.0.1:19096",
  PREVIEW_AUTH: "local",
  PREVIEW_TEST_PATTERN: "1",
  PREVIEW_MAX_SESSIONS: "4",
  PREVIEW_MAX_VIEWERS: "4",
  PREVIEW_HOST_PATH: path.join(build, "dist/native/SimulatorHost"),
  PREVIEW_STATE_DIR: await mkdtemp("/private/tmp/studio-visibility-load-"),
});
const totals = { frames: 0, bytes: 0 };
const studio = createStudio(config, {
  createHost() {
    const host = new SimulatorHost();
    host.on("frame", (frame) => {
      totals.frames++;
      totals.bytes += frame.data.length;
    });
    return host;
  },
});
await studio.ready;
studio.server.listen(config.port, "127.0.0.1");
await once(studio.server, "listening");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pages = [];
const rows = [];
const errors = [];
let browser;
async function visibility(visible) {
  for (const page of pages)
    await page.evaluate((visible) => {
      window.testVisible = visible;
      document.dispatchEvent(new Event("visibilitychange"));
    }, visible);
  await pause(2000);
}
async function sample(state) {
  const start = { ...totals };
  const at = performance.now();
  await pause(5000);
  const seconds = (performance.now() - at) / 1000;
  const row = {
    sessions: pages.length,
    state,
    seconds: +seconds.toFixed(2),
    encodedFps: +((totals.frames - start.frames) / seconds).toFixed(2),
    encodedMbps: +(((totals.bytes - start.bytes) * 8) / seconds / 1e6).toFixed(
      4,
    ),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  for (let count = 1; count <= 4; count++) {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.testVisible = true;
      Object.defineProperty(document, "hidden", {
        get: () => !window.testVisible,
      });
      document.hasFocus = () => window.testVisible;
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    pages.push(page);
    await page.goto(config.origin);
    await page.waitForFunction(
      () => document.querySelector("video").videoWidth > 100,
    );
    await visibility(true);
    assert.equal(studio.pool.sessions.size, count);
    await sample("visible");
    await visibility(false);
    await sample("hidden");
  }
  assert.deepEqual(errors, []);
  await mkdir(".artifacts", { recursive: true });
  await writeFile(
    ".artifacts/visibility-load.json",
    JSON.stringify(
      {
        build,
        date: new Date().toISOString(),
        workload:
          "synthetic color animation, 30 fps, H.264 hardware encoder, localhost Chrome on the host Mac",
        rows,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser?.close();
  await studio.close();
  rtc.cleanup();
}

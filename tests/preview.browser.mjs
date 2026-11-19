import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";
import rtc from "node-datachannel";
import { readConfig } from "../dist/server/config.js";
import { createStudio } from "../dist/server/server.js";
import { listDevices } from "../dist/server/devices.js";
import { PreviewStore } from "../dist/server/preview/store.js";
import { previewConfig } from "../dist/server/preview/config.js";

const directory = await mkdtemp("/private/tmp/preview-integration-");
const template = (await listDevices()).find(
  (d) =>
    d.udid ===
    (process.env.PREVIEW_TEMPLATE ?? "931FE6DE-D134-4A4A-930A-7DFFC9F0E4A4"),
);
assert(template, "Specify an existing iPhone template with PREVIEW_TEMPLATE");
const config = readConfig({
  PREVIEW_STATE_DIR: directory,
  PREVIEW_PORT: "19101",
  PREVIEW_MAX_SESSIONS: "2",
  PREVIEW_SESSION_IDLE_SECONDS: "3600",
});
// Only the GitHub transport is replaced. ZIP validation, install, launch, video and input are real.
const previews = new PreviewStore(
  previewConfig({
    PREVIEW_REPOSITORY: "example/simulator-preview",
    GITHUB_TOKEN: "test",
    PREVIEW_STATE_DIR: directory,
  }),
  {
    async metadata(ref) {
      return {
        repository: "example/simulator-preview",
        run: ref.run,
        artifact: ref.artifact,
        sha: ref.run.padStart(40, "a"),
        pr: Number(ref.run),
        title: "Preview demo integration",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        digest: "integration-fixture-" + ref.key,
      };
    },
    async download(_ref, destination) {
      await cp("example-build/artifact.zip", destination);
    },
  },
);
const studio = createStudio(config, {
  previews,
  listDevices: async () => [template],
});
rtc.initLogger("Error", (_level, message) => console.error(message));
await studio.ready;
studio.server.listen(config.port, "127.0.0.1");
await once(studio.server, "listening");
let browser;
const errors = [];
async function ready(page) {
  await page.waitForFunction(
    () =>
      document.body.dataset.control === "owner" &&
      !document.querySelector('[data-action="home"]').disabled &&
      document.querySelector("video").videoWidth > 100 &&
      document.querySelector("video").classList.contains("visible"),
    {},
    { timeout: 600_000 },
  );
}
async function guestState(udid) {
  const container = execFileSync(
    "xcrun",
    [
      "simctl",
      "get_app_container",
      udid,
      "com.example.simulatorpreview.demo",
      "data",
    ],
    { encoding: "utf8" },
  ).trim();
  return JSON.parse(
    await readFile(`${container}/Documents/preview-state.json`, "utf8"),
  );
}
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const a = await context.newPage();
  a.on("pageerror", (e) => errors.push(e.message));
  await a.goto(config.origin);
  await a.waitForSelector(".preview-gate");
  assert.equal(
    studio.pool.sessions.size,
    0,
    "landing page does not allocate a simulator",
  );
  const denied = await fetch(`${config.origin}/api/builds/1/1`, {
    method: "POST",
  });
  assert.equal(denied.status, 403);
  await a.goto(`${config.origin}/builds/1/1`);
  await ready(a);
  const first = [...studio.pool.sessions.values()][0];
  assert(first.assignment);
  const udidA = first.assignment.udid;
  assert.equal((await guestState(udidA)).count, 0);
  assert.match(await a.locator(".preview-build").innerText(), /PR #1/);
  await mkdir(".artifacts", { recursive: true });
  await a.screenshot({ path: ".artifacts/preview-ready.png" });
  console.log("READY:", udidA, "screenshot .artifacts/preview-ready.png");
  const video = await a.locator("video").evaluate((v) => {
    const b = v.getBoundingClientRect();
    const s = Math.min(b.width / v.videoWidth, b.height / v.videoHeight);
    return {
      x: b.x + (b.width - v.videoWidth * s) / 2,
      y: b.y + (b.height - v.videoHeight * s) / 2,
      width: v.videoWidth * s,
      height: v.videoHeight * s,
    };
  });
  // Locate the demo's broad increment button by a few vertically spaced taps. Each
  // result is verified from the actual app container rather than an input mock.
  let count = 0;
  for (const y of [0.48, 0.44, 0.52, 0.4, 0.56, 0.6]) {
    await a.mouse.click(
      video.x + video.width * 0.5,
      video.y + video.height * y,
    );
    await a.waitForTimeout(400);
    count = (await guestState(udidA)).count;
    if (count) break;
  }
  assert(
    count > 0,
    "WebRTC pointer input increments the actual guest app counter",
  );
  await a.screenshot({ path: ".artifacts/preview-operated.png" });
  console.log("PASS: artifact → install → launch → WebRTC video → guest input");
  const b = await context.newPage();
  b.on("pageerror", (e) => errors.push(e.message));
  await b.goto(`${config.origin}/builds/2/2`);
  await ready(b);
  const second = [...studio.pool.sessions.values()].find((s) => s !== first);
  assert(second.assignment);
  const udidB = second.assignment.udid;
  assert.notEqual(udidA, udidB);
  assert.equal((await guestState(udidB)).count, 0);
  assert.equal(
    (await guestState(udidA)).count,
    count,
    "another PR cannot overwrite the app state",
  );
  assert.match(await b.locator(".preview-build").innerText(), /PR #2/);
  await a.bringToFront();
  await a.reload();
  await ready(a);
  assert.equal(
    [...studio.pool.sessions.values()].find((s) => s.key === first.key)
      .assignment.udid,
    udidA,
  );
  assert.equal(
    (await guestState(udidA)).count,
    count,
    "reloading an active preview preserves its app",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    ".artifacts/preview-result.json",
    JSON.stringify(
      { passed: true, first: udidA, second: udidB, count },
      null,
      2,
    ),
  );
  console.log(
    "PASS: separate builds, isolated app data, pinned version, reconnect, no browser errors",
  );
} finally {
  await browser?.close();
  await studio.close();
  rtc.cleanup();
  const state = JSON.parse(
    await readFile(`${directory}/assignments.json`, "utf8"),
  );
  const devices = JSON.parse(
    execFileSync("xcrun", ["simctl", "list", "devices", "--json"], {
      encoding: "utf8",
    }),
  );
  for (const device of Object.values(devices.devices).flat())
    if (device.name.startsWith(`Studio-${state.installation}-`))
      execFileSync("xcrun", ["simctl", "delete", device.udid]);
  console.log("Removed only integration-test simulators. State:", directory);
}

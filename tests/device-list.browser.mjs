import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const udid = "11111111-1111-4111-8111-111111111111";
const device = {
  udid,
  name: "iPhone Air",
  runtime: "26.2",
  state: "Shutdown",
  family: "iPhone",
  display: { width: 1260, height: 2736, scale: 3 },
};
const connection = `export class Connection {
  ready=false;
  constructor(){window.commands=[];}
  connect(){this.ready=true;this.onmessage({type:'status',connected:false,ready:false,busy:false,switching:false,revision:0});this.onmessage({type:'control',yours:true,owner:'test'});this.onstate('connected');}
  send(command){window.commands.push(command);return true;}
  stop(){}
}`;
const errors = [];
async function fixture(mode) {
  const resuming = mode === "resume";
  let release;
  const catalogReady = new Promise((resolve) => {
    release = resolve;
  });
  const page = await browser.newPage({
    viewport: { width: 420, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 Version/27.2 Mobile/15E148 Safari/604.1",
  });
  page.on(
    "pageerror",
    (e) => (errors.push(e.message), console.error(e.message)),
  );
  let calls = 0;
  await page.addInitScript(
    ({ timeout, standalone }) => {
      Object.defineProperty(navigator, "standalone", { get: () => standalone });
      window.testHidden = false;
      Object.defineProperty(document, "hidden", {
        get: () => window.testHidden,
      });
      if (timeout) {
        const timer = window.setTimeout;
        window.setTimeout = (fn, ms, ...args) =>
          timer(fn, ms === 65000 ? 80 : ms, ...args);
        const fetch = window.fetch;
        let first = true;
        window.fetch = (url, options) => {
          if (url === "/api/devices" && first) {
            first = false;
            return new Promise((_, reject) =>
              options.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              ),
            );
          }
          return fetch(url, options);
        };
      }
    },
    { timeout: mode === "timeout", standalone: !resuming },
  );
  await page.route("http://127.0.0.1:19099/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {} });
    if (path === "/api/devices") {
      calls++;
      if (resuming) {
        await catalogReady;
        return route.fulfill({ json: { devices: [device] } });
      }
      if (mode === "empty") return route.fulfill({ json: { devices: [] } });
      if (mode === "auth")
        return route.fulfill({ status: 403, json: { error: "Forbidden" } });
      if (calls === 1 && mode !== "timeout")
        return route.fulfill({ status: 503, json: { error: "Unavailable" } });
      return route.fulfill({ json: { devices: [device] } });
    }
    if (path === "/connection.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: resuming
          ? connection.replace(
              "connected:false,ready:false",
              `connected:true,ready:true,device:'iPhone Air',udid:'${udid}'`,
            )
          : connection,
      });
    const asset = path === "/" ? "index.html" : path.slice(1);
    if (!/^[a-z0-9.-]+$/.test(asset))
      return route.fulfill({ status: 404, body: "" });
    try {
      const body = await readFile(
        new URL("../dist/web/" + asset, import.meta.url),
      );
      return route.fulfill({
        contentType: asset.endsWith(".js")
          ? "text/javascript"
          : asset.endsWith(".css")
            ? "text/css"
            : "text/html",
        body,
      });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto("http://127.0.0.1:19099/");
  if (resuming || mode === "empty")
    return { page, calls: () => calls, release };
  await page.waitForFunction(
    () =>
      document.querySelector("#placeholder-title").textContent ===
      "Could not load simulators",
  );
  assert.equal(
    await page.locator("body").evaluate((el) => el.classList.contains("focus")),
    true,
  );
  assert.equal(
    await page.locator("#placeholder-detail").isVisible(),
    true,
    "error must be visible in installed-app fullscreen",
  );
  return { page, calls: () => calls };
}
try {
  const resumed = await fixture("resume");
  await resumed.page.waitForFunction(
    () =>
      document.querySelector("#device").value ===
      "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(
    await resumed.page.locator("#device option:checked").textContent(),
    "iPhone Air",
  );
  assert.equal(
    await resumed.page.locator("#device-runtime").textContent(),
    "Loading list…",
  );
  assert.equal(await resumed.page.locator("#device").isDisabled(), true);
  assert.equal(await resumed.page.locator("#select-device").isDisabled(), true);
  assert.equal(
    await resumed.page.locator("#device").getAttribute("aria-busy"),
    "true",
  );
  resumed.release();
  await resumed.page.waitForFunction(
    () => !document.querySelector("#device").disabled,
  );
  assert.equal(await resumed.page.locator("#device").inputValue(), udid);
  assert.equal(
    await resumed.page.locator("#device-runtime").textContent(),
    "iOS 26.2",
  );
  assert.equal(
    await resumed.page.locator("#device").getAttribute("aria-busy"),
    "false",
  );
  assert.equal(
    await resumed.page.evaluate(() =>
      window.commands.some((c) => c.type === "select-device"),
    ),
    false,
    "catalog completion must not restart the restored simulator",
  );
  await resumed.page.close();
  const empty = await fixture("empty");
  await empty.page.waitForFunction(
    () =>
      document.querySelector("#device option").textContent ===
      "No simulators available",
  );
  assert.equal(await empty.page.locator("#device").isDisabled(), true);
  assert.equal(await empty.page.locator("#device-runtime").textContent(), "");
  await empty.page.close();
  const retry = await fixture("retry");
  await retry.page.waitForFunction(() =>
    window.commands.some((c) => c.type === "select-device"),
  );
  assert.equal(retry.calls(), 2);
  assert.equal(await retry.page.locator("#notice").textContent(), "");
  await retry.page.close();
  const hidden = await fixture("hidden");
  await hidden.page.evaluate(() => {
    window.testHidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await hidden.page.waitForTimeout(1300);
  assert.equal(hidden.calls(), 1);
  await hidden.page.evaluate(() => {
    window.testHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await hidden.page.waitForFunction(() =>
    window.commands.some((c) => c.type === "select-device"),
  );
  assert.equal(hidden.calls(), 2);
  await hidden.page.close();
  const auth = await fixture("auth");
  assert.match(
    await auth.page.locator("#placeholder-detail").textContent(),
    /sign in again/,
  );
  await auth.page.waitForTimeout(1300);
  assert.equal(auth.calls(), 1);
  await auth.page.close();
  const timeout = await fixture("timeout");
  await timeout.page.waitForFunction(() =>
    window.commands.some((c) => c.type === "select-device"),
  );
  assert.equal(timeout.calls(), 1);
  await timeout.page.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: browser session restored before catalog, empty-catalog distinction, fullscreen error, automatic recovery and selection, hidden retry pause, authentication handling, stalled-fetch timeout.",
  );
} finally {
  await browser.close();
}

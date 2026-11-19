import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import rtc from "node-datachannel";
import { readConfig } from "../dist/server/config.js";
import { createStudio } from "../dist/server/server.js";
import { SimulatorHost } from "../dist/server/host.js";

// Actual WebRTC/input transport; emulate only the iPhone viewport and simulator screen metadata.
const config = readConfig({
  PREVIEW_PORT: "19093",
  PREVIEW_ORIGIN: "http://127.0.0.1:19093",
  PREVIEW_AUTH: "local",
  PREVIEW_TEST_PATTERN: "1",
});
const commands = [];
const studio = createStudio(config, {
  createHost() {
    const host = new SimulatorHost();
    const send = host.send.bind(host);
    host.send = (command) => {
      commands.push(command);
      send(command);
    };
    return host;
  },
});
studio.server.listen(config.port, "127.0.0.1");
await once(studio.server, "listening");
let browser;
const errors = [];
const device = {
  udid: "00000000-0000-0000-0000-000000000001",
  name: "Matching phone",
  runtime: "26.3",
  state: "Booted",
  family: "iPhone",
  display: { width: 1206, height: 2622, scale: 3 },
};
let dimensions = { width: 1206, height: 2622 };
let statusRoute, latestStatus;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 402, height: 812 },
    screen: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 Version/27.2 Mobile/15E148 Safari/604.1",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { get: () => true });
    window.testScreen = { width: 402, height: 874 };
    Object.defineProperty(screen, "width", {
      get: () => window.testScreen.width,
    });
    Object.defineProperty(screen, "height", {
      get: () => window.testScreen.height,
    });
    // Use the same viewport fullscreen fallback as iPhone Safari.
    HTMLElement.prototype.requestFullscreen = () =>
      Promise.reject(new Error("Use standalone viewport"));
  });
  let releaseCatalog;
  const catalogReady = new Promise((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route("**/api/devices", async (route) => {
    await catalogReady;
    return route.fulfill({ json: { devices: [device] } });
  });
  await page.route("**/style.css", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        "\n.stage { --safe-top: 0px; --safe-bottom: 34px; --safe-left: 0px; --safe-right: 0px; } .focus .stage { height: var(--test-dvh, 100dvh); }",
    });
  });
  await page.routeWebSocket("**/session?*", (route) => {
    statusRoute = route;
    const server = route.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "status") {
        latestStatus = {
          ...message,
          ...dimensions,
          udid: device.udid,
          device: device.name,
        };
        route.send(JSON.stringify(latestStatus));
      } else route.send(raw);
    });
  });
  await page.goto(config.origin);
  await page.waitForFunction(
    () =>
      document.body.dataset.control === "owner" &&
      document.querySelector("#stage").dataset.layout === "matched" &&
      !document.querySelector('[data-action="home"]').disabled,
  );
  assert.equal(
    await page
      .locator("body")
      .evaluate((body) => body.classList.contains("focus")),
    true,
  );
  const manifest = await (
    await page.request.get(config.origin + "/manifest.webmanifest")
  ).json();
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#000000");
  assert.equal(manifest.background_color, "#000000");
  assert.equal(
    await page
      .locator('meta[name="apple-mobile-web-app-status-bar-style"]')
      .count(),
    0,
  );
  const rects = () =>
    page.evaluate(() => {
      const rect = (id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      };
      return { clip: rect("screen-viewport"), frame: rect("screen") };
    });
  assert.deepEqual(await rects(), {
    clip: { left: 0, top: 0, width: 402, height: 812 },
    frame: { left: 0, top: -62, width: 402, height: 874 },
  });
  // The report must capture the current geometry without recalculating or changing it.
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (report) => {
      window.displayReport = report;
    };
  });
  await page.locator("#focus-menu").click();
  const beforeReport = await rects();
  const copiedDialog = page.waitForEvent("dialog").then((dialog) => {
    assert.equal(dialog.type(), "alert");
    return dialog.accept();
  });
  await page.locator("#copy-display-info").click();
  await copiedDialog;
  const report = await page.evaluate(() => JSON.parse(window.displayReport));
  assert.deepEqual(report.source, { width: 402, height: 874 });
  assert.deepEqual(report.window, {
    width: 402,
    height: 812,
    scrollX: 0,
    scrollY: 0,
  });
  assert.equal(report.layout, "matched");
  assert.equal(report.catalogDeviceFound, false);
  assert.equal(report.catalog, "loading");
  assert.equal(report.applied.layout.frame.top, -62);
  assert.equal(JSON.stringify(report).includes(device.udid), false);
  assert.deepEqual(await rects(), beforeReport);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error("Clipboard unavailable");
    };
  });
  const fallbackDialog = page.waitForEvent("dialog").then((dialog) => {
    assert.equal(dialog.type(), "prompt");
    assert.equal(JSON.parse(dialog.defaultValue()).layout, "matched");
    return dialog.dismiss();
  });
  await page.locator("#copy-display-info").click();
  await fallbackDialog;
  await page.locator("#focus-menu").click();
  releaseCatalog();
  await page.waitForFunction(() => !document.querySelector("#device").disabled);
  assert.deepEqual(
    await rects(),
    beforeReport,
    "catalog completion must not change matching geometry",
  );
  assert.equal(
    await page
      .locator("#stage")
      .evaluate((el) => getComputedStyle(el).position),
    "absolute",
  );
  async function tap(x, y, sourceY, width = 402, height = 874) {
    const before = commands.filter(
      (c) => c.type === "pointer" && c.phase === "down",
    ).length;
    await page.touchscreen.tap(x, y);
    for (
      let i = 0;
      i < 50 &&
      commands.filter((c) => c.type === "pointer" && c.phase === "down")
        .length === before;
      i++
    )
      await page.waitForTimeout(20);
    const downs = commands.filter(
      (c) => c.type === "pointer" && c.phase === "down",
    );
    assert.equal(downs.length, before + 1);
    assert.ok(Math.abs(downs.at(-1).x - x / width) < 0.001);
    assert.ok(Math.abs(downs.at(-1).y - sourceY / height) < 0.001);
  }
  await tap(201, 58, 120);
  await tap(201, 790, 852);
  await page.mouse.move(201, 160);
  await page.mouse.down();
  await page.mouse.move(201, -10);
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.ok(
    Math.abs(
      commands.filter((c) => c.type === "pointer" && c.phase === "up").at(-1)
        .y -
        62 / 874,
    ) < 0.001,
  );
  await mkdir(".artifacts", { recursive: true });
  await page.screenshot({ path: ".artifacts/standalone-standard.png" });

  // User's 420x912 screen: the standard status bar occupies 68 points outside
  // the native 420x844 web view. Never expand this viewport to take a screenshot.
  await page.evaluate(() => {
    window.testScreen = { width: 420, height: 912 };
  });
  dimensions = { width: 1260, height: 2736 };
  statusRoute.send(JSON.stringify({ ...latestStatus, ...dimensions }));
  await page.setViewportSize({ width: 420, height: 844 });
  await page.waitForFunction(
    () => document.querySelector("#screen").getBoundingClientRect().top === -68,
  );
  assert.equal(
    await page.locator("#stage").evaluate((s) => s.clientHeight),
    844,
  );
  assert.deepEqual(await rects(), {
    clip: { left: 0, top: 0, width: 420, height: 844 },
    frame: { left: 0, top: -68, width: 420, height: 912 },
  });
  await tap(210, 52, 120, 420, 912);
  await tap(210, 792, 860, 420, 912);
  await tap(210, 809, 877, 420, 912);
  // The last 34 points contain real image content, including the Dock background.
  await tap(210, 827, 895, 420, 912);
  await tap(210, 843, 911, 420, 912);
  assert.equal(
    await page.evaluate(() => {
      const clip = document
        .querySelector("#screen-viewport")
        .getBoundingClientRect();
      return (
        clip.bottom === innerHeight &&
        document.elementFromPoint(210, 843)?.id === "screen"
      );
    }),
    true,
  );
  const screenshot = await page.screenshot({
    path: ".artifacts/standalone-standard-420.png",
  });
  const bottomPixel = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixel = [
      ...context.getImageData(
        Math.floor(bitmap.width / 2),
        bitmap.height - 3,
        1,
        1,
      ).data,
    ];
    bitmap.close();
    return pixel.slice(0, 3);
  }, screenshot.toString("base64"));
  assert.notDeepEqual(
    bottomPixel,
    [17, 25, 39],
    "bottom edge must show the video, not the stage background",
  );

  // A top overlay in a short native viewport must not hide content or the menu.
  await page.evaluate(() => {
    document.querySelector("#stage").style.setProperty("--safe-top", "68px");
    dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(
    () => document.querySelector("#stage").dataset.layout === "matched",
  );
  assert.equal(
    await page.locator("#stage").evaluate((s) => s.clientHeight),
    844,
  );
  const fitted = await rects();
  const scale = (844 - 68) / (912 - 68);
  assert.equal(fitted.clip.top, 68);
  assert.ok(Math.abs(fitted.clip.height + fitted.clip.top - 844) < 0.05);
  assert.ok(Math.abs(fitted.frame.width - 420 * scale) < 0.05);
  assert.ok(Math.abs(fitted.frame.top - (68 - 68 * scale)) < 0.05);
  const menuTop = await page
    .locator("#focus-menu")
    .evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(menuTop >= 68, "menu must be below the actual status bar");
  for (const sourceY of [120, 895, 911]) {
    const before = commands.filter(
      (c) => c.type === "pointer" && c.phase === "down",
    ).length;
    await page.touchscreen.tap(210, 68 + (sourceY - 68) * scale);
    await page.waitForTimeout(100);
    const downs = commands.filter(
      (c) => c.type === "pointer" && c.phase === "down",
    );
    assert.equal(downs.length, before + 1);
    assert.ok(Math.abs(downs.at(-1).x - 0.5) < 0.002);
    assert.ok(Math.abs(downs.at(-1).y - sourceY / 912) < 0.002);
  }
  await page.click("#focus-menu");
  await page.click("#palette-exit");
  assert.equal(
    await page.locator("#stage").evaluate((s) => s.style.height),
    "",
  );
  await page.click("#fullscreen");
  assert.equal(
    await page.locator("#stage").evaluate((s) => s.clientHeight),
    844,
  );

  // Legacy installs that genuinely expose the entire screen can still crop.
  await page.setViewportSize({ width: 420, height: 912 });
  await page.waitForFunction(
    () => document.querySelector("#stage").dataset.layout === "matched",
  );
  await tap(210, 120, 120, 420, 912);
  // CSS viewport units may disagree with innerHeight. Use the actual viewport.
  await page.evaluate(() =>
    document.querySelector("#stage").style.setProperty("--test-dvh", "844px"),
  );
  assert.equal(
    await page.locator("#stage").evaluate((s) => s.clientHeight),
    912,
  );
  await page.evaluate(() => {
    window.testScreen = { width: 402, height: 874 };
  });
  dimensions = { width: 1206, height: 2622 };
  statusRoute.send(JSON.stringify({ ...latestStatus, ...dimensions }));
  await page.setViewportSize({ width: 874, height: 402 });
  await page.waitForFunction(
    () => document.querySelector("#stage").dataset.layout === "fit",
  );
  await page.setViewportSize({ width: 402, height: 874 });
  await page.evaluate(() => {
    document.querySelector("#stage").style.setProperty("--safe-top", "62px");
    dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(
    () => document.querySelector("#stage").dataset.layout === "matched",
  );
  dimensions = { width: 1170, height: 2532 };
  statusRoute.send(JSON.stringify({ ...latestStatus, ...dimensions }));
  await page.waitForFunction(
    () => document.querySelector("#stage").dataset.layout === "fit",
  );
  dimensions = { width: 1206, height: 2622 };
  statusRoute.send(JSON.stringify({ ...latestStatus, ...dimensions }));
  await page.waitForFunction(
    () => document.querySelector("#stage").dataset.layout === "matched",
  );
  await page.click("#focus-menu");
  await page.click("#palette-exit");
  assert.equal(await page.locator("#stage").getAttribute("data-layout"), "fit");
  assert.equal(
    await page.locator("#screen").evaluate((v) => v.style.position),
    "",
  );
  assert.equal(
    await page.locator("#stage").evaluate((s) => s.style.height),
    "",
  );
  await page.click("#fullscreen");
  await page.waitForFunction(
    () => document.querySelector("#stage").dataset.layout === "matched",
  );
  await tap(201, 120, 120);
  // Palette actions use the existing control channel; dismissal must not tap iOS.
  for (const action of ["home", "left", "right"]) {
    const before = commands.filter(
      (c) => c.type === "action" && c.action === action,
    ).length;
    await page.click("#focus-menu");
    await page.click(`[data-palette-action="${action}"]`);
    await page.waitForFunction(
      () => document.querySelector("#focus-palette").hidden,
    );
    for (
      let i = 0;
      i < 50 &&
      commands.filter((c) => c.type === "action" && c.action === action)
        .length === before;
      i++
    )
      await page.waitForTimeout(20);
    assert.equal(
      commands.filter((c) => c.type === "action" && c.action === action).length,
      before + 1,
    );
  }
  await page.click("#focus-menu");
  await page.screenshot({ path: ".artifacts/focus-palette.png" });
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("body").evaluate((b) => b.classList.contains("focus")),
    true,
  );
  assert.equal(
    await page.locator("#focus-menu").getAttribute("aria-expanded"),
    "false",
  );
  await page.click("#focus-menu");
  const pointerCount = commands.filter((c) => c.type === "pointer").length;
  await page.touchscreen.tap(200, 350);
  await page.waitForTimeout(100);
  assert.equal(
    commands.filter((c) => c.type === "pointer").length,
    pointerCount,
  );
  assert.equal(await page.locator("#focus-palette").isHidden(), true);

  // A failed boot must remain readable even if an older server sends a huge log.
  statusRoute.send(
    JSON.stringify({
      ...latestStatus,
      ...dimensions,
      connected: false,
      ready: false,
      switching: false,
      error: "LaunchServicesMigrator /private/diagnostics\n".repeat(1000),
    }),
  );
  await page.waitForFunction(
    () =>
      document.querySelector("#placeholder-title").textContent ===
      "Simulator unavailable",
  );
  assert.ok(
    (await page.locator("#placeholder-detail").innerText()).length < 250,
  );
  assert.ok(
    !(await page.locator("body").innerText()).includes(
      "LaunchServicesMigrator",
    ),
  );
  await page.locator("#show-controls").click();
  assert.equal(
    await page.locator("body").evaluate((b) => b.classList.contains("focus")),
    false,
  );
  await page.locator("#fullscreen").click();
  await page.screenshot({ path: ".artifacts/simulator-error.png" });

  // Installed app chrome remains black during errors and outside the fullscreen view.
  for (const selector of ["html", "body", "#stage", "#placeholder"])
    assert.equal(
      await page
        .locator(selector)
        .evaluate((e) => getComputedStyle(e).backgroundColor),
      "rgb(0, 0, 0)",
    );
  assert.equal(
    await page
      .locator("#placeholder-title")
      .evaluate((e) => getComputedStyle(e).color),
    "rgb(245, 246, 248)",
  );
  assert.equal(
    await page
      .locator("#placeholder-detail")
      .evaluate((e) => getComputedStyle(e).color),
    "rgb(203, 213, 225)",
  );
  await page.locator("#focus-menu").click();
  await page.locator("#palette-exit").click();
  assert.equal(
    await page.locator('meta[name="theme-color"]').getAttribute("content"),
    "#000000",
  );
  assert.equal(
    await page
      .locator("main")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(245, 246, 248)",
  );
  assert.equal(
    await page
      .locator("#placeholder-title")
      .evaluate((e) => getComputedStyle(e).color),
    "rgb(35, 49, 71)",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: standard status bar, bottom-edge pixels and input within the native 420x844 viewport, duplicate safe-area reports, delayed catalog, real WebRTC tap/drag coordinates, orientation fallback, model mismatch, fullscreen exit/re-entry, bounded errors, fixed black app chrome and readable fullscreen errors/control panels.",
  );
} catch (error) {
  console.error("Browser errors:", errors);
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages())
      console.error(
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

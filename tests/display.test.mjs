import test from "node:test";
import assert from "node:assert/strict";
import { displayLayout, logicalSource } from "../dist/web/display.js";
import { normalizedPoint } from "../dist/web/input.js";

const phone = { width: 402, height: 874 };
const state = () => ({
  viewport: phone,
  screen: phone,
  source: phone,
  safe: { top: 62, right: 0, bottom: 34, left: 0 },
  standalone: true,
  focus: true,
});
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("standalone full-screen crops the status area and preserves content to the bottom edge", () => {
  const layout = displayLayout(state());
  assert.equal(layout.matched, true);
  assert.deepEqual(layout.clip, { left: 0, top: 62, width: 402, height: 812 });
  assert.deepEqual(layout.frame, {
    left: 0,
    top: -62,
    width: 402,
    height: 874,
  });
});

test("a safe-top overlay in a short web view keeps all app content and controls below the bar", () => {
  for (const [width, height, top] of [
    [402, 874, 62],
    [420, 912, 68],
  ]) {
    const screen = { width, height };
    const viewport = { width, height: height - top };
    const layout = displayLayout({
      ...state(),
      screen,
      source: screen,
      viewport,
      safe: { top, right: 0, bottom: 34, left: 0 },
    });
    assert.equal(layout.matched, true);
    assert.equal(layout.clip.top, top);
    close(layout.clip.top + layout.clip.height, viewport.height);
    close(layout.frame.width / width, layout.frame.height / height);
    const globalFrame = {
      ...layout.frame,
      left: layout.clip.left + layout.frame.left,
      top: layout.clip.top + layout.frame.top,
    };
    for (const fraction of [0, 0.5, 0.999]) {
      const point = normalizedPoint(
        globalFrame,
        globalFrame.width,
        globalFrame.height,
        width / 2,
        top + fraction * layout.clip.height,
        false,
        layout.clip,
      );
      close(point.x, 0.5);
      close(point.y, (top + fraction * (height - top)) / height);
    }
    assert.equal(
      normalizedPoint(
        globalFrame,
        globalFrame.width,
        globalFrame.height,
        width / 2,
        top - 1,
        false,
        layout.clip,
      ),
      null,
    );
  }
});

test("an OS-reserved status bar with zero safe-area top is removed exactly once", () => {
  const layout = displayLayout({
    ...state(),
    viewport: { width: 402, height: 812 },
    safe: { top: 0, right: 0, bottom: 34, left: 0 },
  });
  assert.equal(layout.matched, true);
  assert.deepEqual(layout.clip, { left: 0, top: 0, width: 402, height: 812 });
  assert.equal(layout.frame.top, -62);
  assert.equal(layout.frame.height, 874);
});

test("the standard status bar leaves the entire usable simulator image inside the native web view", () => {
  const screen = { width: 420, height: 912 };
  const layout = displayLayout({
    ...state(),
    screen,
    source: screen,
    viewport: { width: 420, height: 844 },
    safe: { top: 0, right: 0, bottom: 34, left: 0 },
  });
  assert.equal(layout.matched, true);
  assert.deepEqual(layout.clip, { left: 0, top: 0, width: 420, height: 844 });
  assert.deepEqual(layout.frame, {
    left: 0,
    top: -68,
    width: 420,
    height: 912,
  });
  // Native web view starts at physical y=68. The video must continue to physical y=912.
  for (const sourceY of [120, 860, 877, 895, 911]) {
    close(
      normalizedPoint(
        layout.frame,
        420,
        912,
        210,
        sourceY - 68,
        false,
        layout.clip,
      ).y,
      sourceY / 912,
    );
  }
  assert.equal(
    normalizedPoint(layout.frame, 420, 912, 210, 845, false, layout.clip),
    null,
  );
});

test("devices without Dynamic Island use the measured status bar rather than a fixed notch size", () => {
  const size = { width: 375, height: 667 };
  const layout = displayLayout({
    ...state(),
    screen: size,
    source: size,
    viewport: { width: 375, height: 647 },
    safe: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  assert.equal(layout.frame.top, -20);
  assert.equal(layout.clip.height, 647);
});

test("landscape crops the measured side cutouts and keeps native point dimensions", () => {
  const size = { width: 874, height: 402 };
  const layout = displayLayout({
    ...state(),
    screen: size,
    source: size,
    viewport: size,
    safe: { top: 0, right: 62, bottom: 21, left: 62 },
  });
  assert.equal(layout.matched, true);
  assert.deepEqual(layout.clip, { left: 62, top: 0, width: 750, height: 402 });
  assert.deepEqual(layout.frame, {
    left: -62,
    top: 0,
    width: 874,
    height: 402,
  });
});

test("normal browsing, exit, a different simulator and keyboard layouts preserve the whole image", () => {
  for (const extra of [
    { standalone: false },
    { focus: false },
    { source: undefined },
    { source: { width: 390, height: 844 } },
    { source: { width: 874, height: 402 } },
    { viewport: { width: 402, height: 500 } },
    { viewport: { width: 402, height: 800 } },
    { viewport: { width: 350, height: 874 } },
    { safe: { top: NaN, right: 0, bottom: 0, left: 0 } },
  ])
    assert.equal(displayLayout({ ...state(), ...extra }).matched, false);
});

test("visible taps map to the same simulator point with an overlaid or OS-reserved status bar", () => {
  for (const reserved of [0, 62]) {
    const layout = displayLayout({
      ...state(),
      viewport: { width: 402, height: 874 - reserved },
      safe: { ...state().safe, top: reserved ? 0 : 62 },
    });
    const frame = {
      ...layout.frame,
      left: layout.clip.left + layout.frame.left,
      top: layout.clip.top + layout.frame.top,
    };
    const point = normalizedPoint(
      frame,
      frame.width,
      frame.height,
      201,
      120 - reserved,
      false,
      layout.clip,
    );
    close(point.x, 0.5);
    close(point.y, 120 / 874);
    assert.equal(
      normalizedPoint(
        frame,
        frame.width,
        frame.height,
        201,
        layout.clip.top - 1,
        false,
        layout.clip,
      ),
      null,
    );
    close(
      normalizedPoint(
        frame,
        frame.width,
        frame.height,
        201,
        -100,
        true,
        layout.clip,
      ).y,
      62 / 874,
    );
    close(
      normalizedPoint(
        frame,
        frame.width,
        frame.height,
        201,
        2000,
        true,
        layout.clip,
      ).y,
      1,
    );
  }
});

test("landscape pointer capture clamps at the visible crop rather than hidden simulator controls", () => {
  const frame = { left: 0, top: 0, width: 874, height: 402 };
  const clip = { left: 62, top: 0, width: 750, height: 402 };
  close(normalizedPoint(frame, 874, 402, -1, 200, true, clip).x, 62 / 874);
  close(normalizedPoint(frame, 874, 402, 1000, 200, true, clip).x, 812 / 874);
  assert.equal(normalizedPoint(frame, 874, 402, 30, 200, false, clip), null);
});

test("aspect-fit input still excludes letterboxing inside a clipped viewport", () => {
  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  const clip = { left: 0, top: 100, width: 1000, height: 800 };
  assert.equal(normalizedPoint(rect, 500, 1000, 100, 500, false, clip), null);
  assert.deepEqual(normalizedPoint(rect, 500, 1000, 500, 500, false, clip), {
    x: 0.5,
    y: 0.5,
  });
  assert.deepEqual(normalizedPoint(rect, 500, 1000, 500, -50, true, clip), {
    x: 0.5,
    y: 0.1,
  });
});

test("native pixels recover an exact matching screen before the catalog arrives", () => {
  const client = { width: 420, height: 912, scale: 3 };
  assert.deepEqual(
    logicalSource({ width: 1260, height: 2736 }, undefined, client),
    { width: 420, height: 912 },
  );
  assert.deepEqual(
    logicalSource({ width: 2736, height: 1260 }, undefined, client),
    { width: 912, height: 420 },
  );
  for (const pixels of [
    { width: 588, height: 1280 },
    { width: 1170, height: 2532 },
    { width: 0, height: 0 },
    { width: NaN, height: 2736 },
  ])
    assert.equal(logicalSource(pixels, undefined, client), undefined);
  assert.equal(
    logicalSource({ width: 1260, height: 2736 }, undefined, {
      ...client,
      scale: 2,
    }),
    undefined,
  );
  assert.equal(
    logicalSource({ width: 1260, height: 2736 }, undefined, {
      ...client,
      scale: NaN,
    }),
    undefined,
  );
  assert.deepEqual(logicalSource({ width: 750, height: 1334 }, 2, client), {
    width: 375,
    height: 667,
  });
  assert.equal(
    logicalSource({ width: 1260, height: 2736 }, 0, client),
    undefined,
  );
  // Profile metadata remains authoritative, even if physical dimensions coincide.
  assert.deepEqual(logicalSource({ width: 1260, height: 2736 }, 2, client), {
    width: 630,
    height: 1368,
  });
});

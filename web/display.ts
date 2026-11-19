import { normalizedPoint, type PointRect } from "./input.js";

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export interface LogicalScreen {
  width: number;
  height: number;
}
export interface DisplayLayout {
  clip: PointRect;
  frame: PointRect;
  matched: boolean;
}
interface LayoutInput {
  viewport: LogicalScreen;
  screen: LogicalScreen;
  source?: LogicalScreen;
  safe: Insets;
  standalone: boolean;
  focus: boolean;
}

/** Native status reports physical screen pixels, independently of the scaled video stream. */
export function logicalSource(
  pixels: LogicalScreen,
  profileScale: number | undefined,
  client: LogicalScreen & { scale: number },
): LogicalScreen | undefined {
  if (
    ![pixels.width, pixels.height].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return undefined;
  if (profileScale !== undefined) {
    if (!Number.isFinite(profileScale) || profileScale <= 0) return undefined;
    return {
      width: pixels.width / profileScale,
      height: pixels.height / profileScale,
    };
  }
  // A restored stream may arrive before /api/devices. Only use the client's scale
  // when BOTH physical dimensions match; a similar aspect ratio is insufficient.
  if (
    ![client.width, client.height, client.scale].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return undefined;
  const source = [pixels.width, pixels.height].sort((a, b) => a - b);
  const target = [
    client.width * client.scale,
    client.height * client.scale,
  ].sort((a, b) => a - b);
  if (source.some((value, index) => Math.abs(value - target[index]!) > 1))
    return undefined;
  return {
    width: pixels.width / client.scale,
    height: pixels.height / client.scale,
  };
}

/** Layout coordinates are CSS points. Stream resolution does not change input coordinates. */
export function displayLayout({
  viewport,
  screen,
  source,
  safe,
  standalone,
  focus,
}: LayoutInput): DisplayLayout {
  const full = {
    left: 0,
    top: 0,
    width: viewport.width,
    height: viewport.height,
  };
  const fallback = { clip: full, frame: full, matched: false };
  if (
    !standalone ||
    !focus ||
    !source ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return fallback;
  // Only infer the simulator's system insets when its full screen matches this phone.
  // Cropping a different model could remove app content rather than the system bar.
  if (
    Math.abs(source.width - screen.width) > 1 ||
    Math.abs(source.height - screen.height) > 1 ||
    Math.abs(viewport.width - screen.width) > 1
  )
    return fallback;
  const missingHeight = Math.max(0, screen.height - viewport.height);
  // A keyboard / split view / browser toolbar is not a status bar.
  if (
    viewport.height > screen.height + 1 ||
    missingHeight > Math.min(100, screen.height * 0.15) ||
    (screen.width > screen.height && missingHeight > 1)
  )
    return fallback;
  // A safe top is an overlay inside the reported viewport, including installed
  // apps whose viewport is also shorter than the screen. Do not subtract it as
  // an OS-reserved bar: doing so puts both content and controls behind the bar.
  // Unrelated height deficits may be browser chrome or a keyboard.
  if (
    safe.top > 0 &&
    missingHeight > 1 &&
    Math.abs(safe.top - missingHeight) > 1
  )
    return fallback;
  const reservedTop = safe.top > 0 ? 0 : missingHeight;
  const top = Math.max(safe.top, reservedTop);
  const insets = {
    top,
    right: safe.right,
    bottom: safe.bottom,
    left: safe.left,
  };
  if (
    Object.values(insets).some(
      (value) => !Number.isFinite(value) || value < 0,
    ) ||
    insets.left + insets.right >= screen.width ||
    top + insets.bottom >= screen.height
  )
    return fallback;
  const clipTop = top - reservedTop;
  const sourceWidth = screen.width - insets.left - insets.right;
  const sourceHeight = screen.height - top;
  // Keep every app pixel below the simulated status bar, including the Dock.
  // If iOS exposes less usable height, reduce the image uniformly instead of
  // cropping the Dock, stretching it, or drawing controls outside the viewport.
  const scale = Math.min(1, (viewport.height - clipTop) / sourceHeight);
  const width = sourceWidth * scale;
  return {
    clip: {
      left: insets.left + (sourceWidth - width) / 2,
      top: clipTop,
      width,
      height: sourceHeight * scale,
    },
    frame: {
      left: 0 - insets.left * scale,
      top: 0 - top * scale,
      width: screen.width * scale,
      height: screen.height * scale,
    },
    matched: true,
  };
}

export function isStandalone() {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    matchMedia("(display-mode: standalone)").matches ||
    matchMedia("(display-mode: fullscreen)").matches
  );
}

/** Applies one geometry to both the displayed video and pointer mapping. */
export class ScreenDisplay {
  private source?: LogicalScreen;
  private signature = "";
  private matched = false;
  constructor(
    private stage: HTMLElement,
    private viewport: HTMLElement,
    private video: HTMLVideoElement,
    private cancelTouch: () => void,
  ) {
    new ResizeObserver(() => this.refresh()).observe(stage);
    window.addEventListener("resize", () => this.refresh());
    window.visualViewport?.addEventListener("resize", () => this.refresh());
    window.visualViewport?.addEventListener("scroll", () => this.refresh());
  }

  setSource(source?: LogicalScreen) {
    if (
      source?.width === this.source?.width &&
      source?.height === this.source?.height
    )
      return;
    this.source = source;
    this.refresh();
  }

  refresh() {
    const style = getComputedStyle(this.stage);
    const inset = (edge: string) =>
      parseFloat(style.getPropertyValue(`--safe-${edge}`)) || 0;
    const landscape = innerWidth > innerHeight;
    const size = [screen.width, screen.height].sort((a, b) => a - b);
    const focus = document.body.classList.contains("focus");
    const standalone =
      isStandalone() &&
      document.body.classList.contains("mobile") &&
      Math.abs((window.visualViewport?.scale ?? 1) - 1) < 0.01 &&
      Math.abs((window.visualViewport?.height ?? innerHeight) - innerHeight) <
        2;
    // Use the actual web viewport, not screen.height or CSS vh/lvh, which can
    // include the OS-owned status bar in an installed iPhone web app.
    const viewport =
      standalone && focus
        ? { width: innerWidth, height: innerHeight }
        : { width: this.stage.clientWidth, height: this.stage.clientHeight };
    if (standalone && focus && (scrollX !== 0 || scrollY !== 0))
      window.scrollTo(0, 0);
    const layout = displayLayout({
      viewport,
      screen: {
        width: size[landscape ? 1 : 0]!,
        height: size[landscape ? 0 : 1]!,
      },
      source: this.source,
      safe: {
        top: inset("top"),
        right: inset("right"),
        bottom: inset("bottom"),
        left: inset("left"),
      },
      standalone,
      focus,
    });
    const signature = JSON.stringify({
      layout,
      fullscreen: standalone && focus,
    });
    if (signature === this.signature) return;
    this.cancelTouch();
    this.signature = signature;
    this.matched = layout.matched;
    this.stage.dataset.layout = layout.matched ? "matched" : "fit";
    if (standalone && focus) this.stage.style.height = `${viewport.height}px`;
    else this.stage.style.removeProperty("height");
    for (const [element, rect] of [
      [this.viewport, layout.clip],
      [this.video, layout.frame],
    ] as const) {
      if (layout.matched) {
        element.style.position = "absolute";
        element.style.left = `${rect.left}px`;
        element.style.top = `${rect.top}px`;
        element.style.width = `${rect.width}px`;
        element.style.height = `${rect.height}px`;
      } else {
        for (const property of ["position", "left", "top", "width", "height"])
          element.style.removeProperty(property);
      }
    }
    // The encoder rounds dimensions to even pixels. Fill the known logical screen exactly
    // instead of letting that rounding introduce tiny letterboxes or coordinate offsets.
    this.video.style.objectFit = layout.matched ? "fill" : "contain";
    this.stage.style.setProperty(
      "--controls-top",
      `${Math.max(inset("top"), layout.matched ? layout.clip.top : 0)}px`,
    );
  }

  /** Local-only geometry report: no account IDs, tokens, URLs or simulator contents. */
  diagnostics() {
    const rect = (element: HTMLElement) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const style = getComputedStyle(this.stage);
    const visual = window.visualViewport;
    return {
      version: 3,
      standalone: isStandalone(),
      mobile: document.body.classList.contains("mobile"),
      focus: document.body.classList.contains("focus"),
      source: this.source ?? null,
      screen: {
        width: screen.width,
        height: screen.height,
        dpr: devicePixelRatio,
      },
      window: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      document: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      visual: visual
        ? {
            width: visual.width,
            height: visual.height,
            scale: visual.scale,
            offsetTop: visual.offsetTop,
            offsetLeft: visual.offsetLeft,
            pageTop: visual.pageTop,
            pageLeft: visual.pageLeft,
          }
        : null,
      safe: Object.fromEntries(
        ["top", "right", "bottom", "left"].map((edge) => [
          edge,
          style.getPropertyValue(`--safe-${edge}`).trim(),
        ]),
      ),
      stage: rect(this.stage),
      clip: rect(this.viewport),
      frame: rect(this.video),
      video: { width: this.video.videoWidth, height: this.video.videoHeight },
      layout: this.stage.dataset.layout,
      applied: this.signature ? JSON.parse(this.signature) : null,
    };
  }

  point(x: number, y: number, clamp: boolean) {
    const rect = this.video.getBoundingClientRect();
    return normalizedPoint(
      rect,
      this.matched ? rect.width : this.video.videoWidth,
      this.matched ? rect.height : this.video.videoHeight,
      x,
      y,
      clamp,
      this.viewport.getBoundingClientRect(),
    );
  }
}

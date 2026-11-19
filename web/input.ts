export interface PointRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function normalizedPoint(
  rect: PointRect,
  width: number,
  height: number,
  x: number,
  y: number,
  clamp: boolean,
  clip?: PointRect,
) {
  if (!width || !height || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const drawnWidth = width * scale,
    drawnHeight = height * scale;
  const left = rect.left + (rect.width - drawnWidth) / 2;
  const top = rect.top + (rect.height - drawnHeight) / 2;
  const minX = Math.max(left, clip?.left ?? left);
  const minY = Math.max(top, clip?.top ?? top);
  const maxX = Math.min(
    left + drawnWidth,
    clip ? clip.left + clip.width : left + drawnWidth,
  );
  const maxY = Math.min(
    top + drawnHeight,
    clip ? clip.top + clip.height : top + drawnHeight,
  );
  if (maxX <= minX || maxY <= minY) return null;
  if (!clamp && (x < minX || x > maxX || y < minY || y > maxY)) return null;
  return {
    x: (Math.max(minX, Math.min(maxX, x)) - left) / drawnWidth,
    y: (Math.max(minY, Math.min(maxY, y)) - top) / drawnHeight,
  };
}

export function bindInput(
  video: HTMLVideoElement,
  canInput: () => boolean,
  revision: () => number,
  send: (message: object) => boolean,
  mapPoint?: (
    x: number,
    y: number,
    clamp: boolean,
  ) => { x: number; y: number } | null,
) {
  let pointer: number | null = null;
  let pending: object | undefined;
  let scheduled = 0;
  const cancel = () => {
    pending = undefined;
    cancelAnimationFrame(scheduled);
    scheduled = 0;
    if (pointer !== null) {
      send({ type: "cancel" });
      pointer = null;
    }
  };
  const position = (event: PointerEvent, clamp: boolean) =>
    mapPoint
      ? mapPoint(event.clientX, event.clientY, clamp)
      : normalizedPoint(
          video.getBoundingClientRect(),
          video.videoWidth,
          video.videoHeight,
          event.clientX,
          event.clientY,
          clamp,
        );
  video.addEventListener("pointerdown", (event) => {
    if (
      pointer !== null ||
      !canInput() ||
      (event.pointerType === "mouse" && event.button !== 0)
    )
      return;
    const point = position(event, false);
    if (!point) return;
    event.preventDefault();
    pointer = event.pointerId;
    video.setPointerCapture(pointer);
    send({ type: "pointer", phase: "down", revision: revision(), ...point });
  });
  video.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointer) return;
    if (!canInput()) {
      cancel();
      return;
    }
    const point = position(event, true);
    if (!point) return;
    pending = {
      type: "pointer",
      phase: "move",
      revision: revision(),
      ...point,
    };
    if (!scheduled)
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        if (pending) send(pending);
        pending = undefined;
      });
  });
  video.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointer) return;
    const point = position(event, true);
    pending = undefined;
    cancelAnimationFrame(scheduled);
    scheduled = 0;
    if (point && canInput())
      send({ type: "pointer", phase: "up", revision: revision(), ...point });
    else send({ type: "cancel" });
    pointer = null;
  });
  video.addEventListener("pointercancel", cancel);
  video.addEventListener("lostpointercapture", cancel);
  video.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("blur", cancel);
  new ResizeObserver(cancel).observe(video);
  return cancel;
}

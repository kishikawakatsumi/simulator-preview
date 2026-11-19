export interface Device {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  family?: string;
  display?: { width: number; height: number; scale: number };
}
export interface ClientScreen {
  width: number;
  height: number;
  scale: number;
  family?: "iPhone" | "iPad";
}

export function clientScreen(): ClientScreen {
  const agent = navigator.userAgent;
  // iPadOS can identify as a Mac. Use touch support only to distinguish that case.
  const tablet =
    /iPad/.test(agent) ||
    (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
  const family = tablet
    ? "iPad"
    : /iPhone|iPod|Android.*Mobile/.test(agent)
      ? "iPhone"
      : /Android/.test(agent)
        ? "iPad"
        : undefined;
  return {
    width: screen.width,
    height: screen.height,
    scale: devicePixelRatio,
    family,
  };
}

/** Match the screen, not the viewport (which shrinks with browser chrome and keyboards). */
export function chooseDevice(
  devices: Device[],
  screen: ClientScreen,
  current?: string,
): Device | undefined {
  const family = devices.filter((device) => device.family === screen.family);
  const candidates = screen.family && family.length ? family : devices;
  const short = Math.min(screen.width, screen.height);
  const long = Math.max(screen.width, screen.height);
  const compareFallback = (a: Device, b: Device) =>
    Number(b.udid === current) - Number(a.udid === current) ||
    Number(b.state === "Booted") - Number(a.state === "Booted") ||
    (!screen.family
      ? Number(b.family === "iPhone") - Number(a.family === "iPhone")
      : 0) ||
    b.runtime.localeCompare(a.runtime, undefined, { numeric: true }) ||
    a.name.localeCompare(b.name) ||
    a.udid.localeCompare(b.udid);
  const score = (device: Device): [number, number] => {
    if (!device.display) return [3, 0];
    const { width, height, scale } = device.display;
    const w = Math.min(width, height),
      h = Math.max(width, height);
    const pixelExact =
      Math.abs(w - short * screen.scale) <= 1 &&
      Math.abs(h - long * screen.scale) <= 1;
    const sizeExact =
      Math.abs(w / scale - short) <= 1 && Math.abs(h / scale - long) <= 1;
    // Logical size matters most for the UI; physical resolution breaks near matches.
    const distance =
      Math.abs(Math.log(w / scale / short)) +
      Math.abs(Math.log(h / scale / long)) +
      0.25 *
        (Math.abs(Math.log(w / (short * screen.scale))) +
          Math.abs(Math.log(h / (long * screen.scale))));
    return [pixelExact ? 0 : sizeExact ? 1 : 2, distance];
  };
  return [...candidates].sort((a, b) => {
    if (!screen.family || short <= 0 || long <= 0 || screen.scale <= 0)
      return compareFallback(a, b);
    const sa = score(a),
      sb = score(b);
    return (
      sa[0] - sb[0] ||
      (sa[0] === 2 ? sa[1] - sb[1] : 0) ||
      compareFallback(a, b)
    );
  })[0];
}

import type { Device } from "../devices.js";
export function compatibleDevice(device: Device, minimum: string) {
  const runtime = device.runtime.replace(/^iOS\s*/, "");
  if (!/^\d+(\.\d+)*$/.test(runtime)) return false;
  const actual = runtime.split(".").map(Number),
    required = minimum.split(".").map(Number);
  for (
    let index = 0;
    index < Math.max(actual.length, required.length);
    index++
  ) {
    const difference = (actual[index] ?? 0) - (required[index] ?? 0);
    if (difference) return difference > 0;
  }
  return true;
}

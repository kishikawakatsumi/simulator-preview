import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const exec = promisify(execFile);

export interface DeviceDisplay {
  width: number;
  height: number;
  scale: number;
}
export interface Device {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  deviceTypeIdentifier?: string;
  runtimeIdentifier?: string;
  family?: string;
  display?: DeviceDisplay;
}
interface DeviceType {
  identifier: string;
  bundlePath: string;
  productFamily: string;
}
interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  deviceTypeIdentifier: string;
}
let cache: Device[] = [];
let refreshed = 0;
let loading: Promise<Device[]> | undefined;
const displays = new Map<string, Promise<DeviceDisplay | undefined>>();

export function displayFromProfile(
  profile: Record<string, unknown>,
): DeviceDisplay | undefined {
  const {
    mainScreenWidth: width,
    mainScreenHeight: height,
    mainScreenScale: scale,
  } = profile;
  if (
    [width, height, scale].some(
      (value) =>
        typeof value !== "number" || !Number.isFinite(value) || value <= 0,
    )
  )
    return undefined;
  return {
    width: width as number,
    height: height as number,
    scale: scale as number,
  };
}

function readDisplay(type: DeviceType): Promise<DeviceDisplay | undefined> {
  let display = displays.get(type.bundlePath);
  if (!display) {
    // Read Xcode's device profiles instead of maintaining a model/resolution table.
    // A missing profile only disables matching for that type; manual selection still works.
    display = exec(
      "/usr/bin/plutil",
      [
        "-convert",
        "json",
        "-o",
        "-",
        path.join(type.bundlePath, "Contents/Resources/profile.plist"),
      ],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    )
      .then(({ stdout }) => displayFromProfile(JSON.parse(stdout)))
      .catch(() => undefined);
    displays.set(type.bundlePath, display);
  }
  return display;
}

export function invalidateDevices() {
  refreshed = 0;
}

export async function listDevices(includeManaged = false): Promise<Device[]> {
  const visible = (devices: Device[]) =>
    includeManaged
      ? devices
      : devices.filter((device) => !device.name.startsWith("Studio-"));
  if (Date.now() - refreshed < 10_000) return visible(cache);
  if (loading) return visible(await loading);
  loading = (async () => {
    const { stdout } = await exec(
      "/usr/bin/xcrun",
      ["simctl", "list", "--json"],
      {
        // Initial simulator migrations can delay CoreSimulator's inventory response.
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const data = JSON.parse(stdout) as {
      devices: Record<string, SimctlDevice[]>;
      devicetypes: DeviceType[];
    };
    const types = new Map(
      data.devicetypes.map((type) => [type.identifier, type]),
    );
    cache = await Promise.all(
      Object.entries(data.devices)
        .filter(([runtime]) => runtime.includes(".iOS-"))
        .flatMap(([runtime, devices]) =>
          devices
            .filter((device) => device.isAvailable)
            .map(async (device): Promise<Device> => {
              const type = types.get(device.deviceTypeIdentifier);
              return {
                udid: device.udid,
                name: device.name,
                state: device.state,
                deviceTypeIdentifier: device.deviceTypeIdentifier,
                runtimeIdentifier: runtime,
                runtime: runtime.split(".iOS-")[1]!.replaceAll("-", "."),
                family: type?.productFamily,
                display: type ? await readDisplay(type) : undefined,
              };
            }),
        ),
    );
    cache.sort(
      (a, b) =>
        b.runtime.localeCompare(a.runtime, undefined, { numeric: true }) ||
        a.name.localeCompare(b.name),
    );
    refreshed = Date.now();
    return cache;
  })();
  try {
    return visible(await loading);
  } finally {
    loading = undefined;
  }
}

import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";

const udid = process.argv[2];
if (!udid || !/^[\da-f-]{36}$/i.test(udid))
  throw new Error("Usage: npm run test:simulator -- <UDID>");
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();
const devices = JSON.parse(
  run("xcrun", ["simctl", "list", "devices", "available", "--json"]),
);
const original = Object.values(devices.devices)
  .flat()
  .find((device) => device.udid === udid);
if (!original) throw new Error("Device not found");
const bundle = "dev.internal.SimulatorStudio.TouchProbe";
const app = path.resolve(".artifacts/StudioTouchProbe.app");
await mkdir(app, { recursive: true });
run("xcrun", [
  "--sdk",
  "iphonesimulator",
  "swiftc",
  "tests/TouchProbe/main.swift",
  "-sdk",
  run("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]),
  "-target",
  "arm64-apple-ios17.0-simulator",
  "-o",
  path.join(app, "TouchProbe"),
]);
await writeFile(
  path.join(app, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>TouchProbe</string>
<key>CFBundleName</key><string>Studio Touch Probe</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string>
<key>MinimumOSVersion</key><string>17.0</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
<key>UILaunchScreen</key><dict/><key>UIApplicationSceneManifest</key><dict>
<key>UIApplicationSupportsMultipleScenes</key><false/><key>UISceneConfigurations</key><dict/></dict>
<key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string>
<string>UIInterfaceOrientationPortraitUpsideDown</string><string>UIInterfaceOrientationLandscapeLeft</string>
<string>UIInterfaceOrientationLandscapeRight</string></array></dict></plist>`,
);
run("codesign", ["--force", "--sign", "-", app]);
{
  const child = spawn(process.execPath, ["tests/browser.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PREVIEW_DEVICE: udid,
      PREVIEW_APP_PATH: app,
      PREVIEW_PROBE: bundle,
      PREVIEW_TEST_PICKER: "1",
    },
  });
  const [code] = await once(child, "exit");
  if (code !== 0) process.exitCode = code ?? 1;
}

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, copyFile, chmod } from "node:fs/promises";

const build = spawn(
  "swift",
  ["build", "--package-path", "native", "-c", "release"],
  {
    stdio: "inherit",
  },
);
const [code] = await once(build, "exit");
if (code !== 0) process.exit(code ?? 1);
await mkdir("dist/native", { recursive: true });
await copyFile(
  "native/.build/release/SimulatorHost",
  "dist/native/SimulatorHost",
);
await chmod("dist/native/SimulatorHost", 0o755);

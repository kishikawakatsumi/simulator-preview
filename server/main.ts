import { previewConfig } from "./preview/config.js";
import { PreviewStore } from "./preview/store.js";
import rtc from "node-datachannel";
import { readConfig } from "./config.js";
import { createStudio } from "./server.js";

try {
  const config = readConfig();
  rtc.initLogger("Error", (_level, message) => console.error(message));
  const previews = new PreviewStore(previewConfig());
  const studio = createStudio(config, { previews });
  try {
    await studio.ready;
  } catch (error) {
    await studio.close().catch(() => {});
    throw error;
  }
  studio.server.listen(config.port, "127.0.0.1", () => {
    console.log(
      `Simulator Preview: ${config.origin}${previews.config.demo ? "/builds/1/1" : ""}`,
    );
    console.log(
      `Authentication: ${config.mode}; TURN: ${config.turnKeyID ? "configured" : "not configured"}`,
    );
  });
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    try {
      await studio.close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      rtc.cleanup();
    }
  }
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  studio.server.on("error", (error) => {
    console.error(error.message);
    void stop();
    process.exitCode = 1;
  });
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Failed to start Simulator Preview",
  );
  process.exitCode = 1;
}

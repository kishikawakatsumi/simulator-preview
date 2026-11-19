import { resolve } from "node:path";

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${key} must be ${min}–${max}`);
    return value;
  };
  const port = integer("PREVIEW_PORT", 8091, 1024, 65535);
  const origin = new URL(env.PREVIEW_ORIGIN ?? `http://127.0.0.1:${port}`);
  const mode = env.PREVIEW_AUTH ?? "local";
  if (!["local", "access"].includes(mode))
    throw new Error("PREVIEW_AUTH must be local or access");
  if (origin.origin !== origin.href.replace(/\/$/, ""))
    throw new Error("PREVIEW_ORIGIN must contain only an origin");
  if (mode === "local" && origin.origin !== `http://127.0.0.1:${port}`) {
    throw new Error(
      "Local authentication requires a loopback origin. Use Access for a public hostname.",
    );
  }
  const accessIssuer = env.CF_ACCESS_ISSUER?.replace(/\/$/, "");
  if (
    mode === "access" &&
    (origin.protocol !== "https:" || !accessIssuer || !env.CF_ACCESS_AUD)
  ) {
    throw new Error(
      "Public use requires HTTPS PREVIEW_ORIGIN, CF_ACCESS_ISSUER and CF_ACCESS_AUD",
    );
  }
  if (
    accessIssuer &&
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(accessIssuer)
  ) {
    throw new Error(
      "CF_ACCESS_ISSUER must be your https://TEAM.cloudflareaccess.com URL",
    );
  }
  if (!!env.CF_TURN_KEY_ID !== !!env.CF_TURN_API_TOKEN)
    throw new Error("Set both CF_TURN_KEY_ID and CF_TURN_API_TOKEN");
  const relayOnly = env.PREVIEW_RELAY_ONLY === "1";
  if (relayOnly && !env.CF_TURN_KEY_ID)
    throw new Error("Relay-only mode requires Cloudflare TURN credentials");
  return {
    port,
    origin: origin.origin,
    mode,
    accessIssuer,
    accessAudience: env.CF_ACCESS_AUD,
    turnKeyID: env.CF_TURN_KEY_ID,
    turnToken: env.CF_TURN_API_TOKEN,
    relayOnly,
    maxPeers: integer("PREVIEW_MAX_VIEWERS", 4, 1, 48),
    maxSessions: integer("PREVIEW_MAX_SESSIONS", 2, 1, 12),
    sessionIdleMs: integer("PREVIEW_SESSION_IDLE_SECONDS", 60, 5, 3600) * 1000,
    stateDirectory: resolve(env.PREVIEW_STATE_DIR ?? ".preview"),
    fps: integer("PREVIEW_FPS", 30, 5, 60),
    maxEdge: integer("PREVIEW_MAX_EDGE", 1280, 320, 1920),
    bitrate: integer("PREVIEW_BITRATE", 4_000_000, 300_000, 12_000_000),
    hostPath: resolve(env.PREVIEW_HOST_PATH ?? "dist/native/SimulatorHost"),
    device: env.PREVIEW_DEVICE,
    appPath: env.PREVIEW_APP_PATH,
    bundleID: env.PREVIEW_BUNDLE_ID,
    testPattern: env.PREVIEW_TEST_PATTERN === "1",
  };
}
export type Config = ReturnType<typeof readConfig>;

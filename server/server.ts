import { compatibleDevice } from "./preview/compatibility.js";
import { buildReference } from "./preview/config.js";
import { previewRoute } from "./preview/routes.js";
import type { PreviewStore } from "./preview/store.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createAuthenticator, type Identity } from "./auth.js";
import { iceServers } from "./turn.js";
import { listDevices } from "./devices.js";
import {
  SessionPool,
  type StudioSession,
  type SessionOptions,
} from "./sessions.js";
import { sessionKey } from "./assignments.js";
import { ViewerPeer } from "./peer.js";
import type { Config } from "./config.js";
import type { Input, VideoFrame } from "./protocol.js";

interface Viewer {
  minimumOS?: string;
  id: string;
  identity: Identity;
  socket: WebSocket;
  session: StudioSession;
  peer?: ViewerPeer;
  alive: boolean;
  created: number;
  qualityAt: number;
  targetBitrate: number;
  visible: boolean;
}

export interface StudioOptions extends SessionOptions {
  previews?: PreviewStore;
  authenticate?: ReturnType<typeof createAuthenticator>;
  listDevices?: typeof listDevices;
}

export function createStudio(config: Config, options: StudioOptions = {}) {
  const authenticate = options.authenticate ?? createAuthenticator(config);
  const catalog = options.listDevices ?? listDevices;
  const viewers = new Map<string, Viewer>();
  const streaming = new WeakSet<StudioSession>();
  let closing = false;
  let pendingUpgrades = 0;
  const pool = new SessionPool(config, options, (session) => {
    session.on("control", () => broadcastControl(session));
    session.on("status", (status) => {
      for (const viewer of members(session)) send(viewer, status);
    });
    session.on("frame", (frame: VideoFrame) => {
      for (const viewer of members(session)) {
        try {
          viewer.peer?.send(frame);
        } catch (error) {
          console.error("Video send failed:", error);
          remove(viewer);
        }
      }
    });
  });
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  const server = createServer((request, response) => {
    void route(request, response);
  });
  const assets: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/style.css": ["style.css", "text/css"],
    "/preview.js": ["preview.js", "text/javascript"],
    "/app.js": ["app.js", "text/javascript"],
    "/connection.js": ["connection.js", "text/javascript"],
    "/client-identity.js": ["client-identity.js", "text/javascript"],
    "/input.js": ["input.js", "text/javascript"],
    "/stats.js": ["stats.js", "text/javascript"],
    "/device-selection.js": ["device-selection.js", "text/javascript"],
    "/auto-connect.js": ["auto-connect.js", "text/javascript"],
    "/display.js": ["display.js", "text/javascript"],
    "/manifest.webmanifest": [
      "manifest.webmanifest",
      "application/manifest+json",
    ],
  };

  function send(viewer: Viewer, message: object) {
    if (viewer.socket.readyState !== WebSocket.OPEN) return;
    if (viewer.socket.bufferedAmount > 128 * 1024) {
      remove(viewer);
      return;
    }
    viewer.socket.send(JSON.stringify(message));
  }
  function members(session: StudioSession) {
    return [...viewers.values()].filter((viewer) => viewer.session === session);
  }
  function broadcastControl(session: StudioSession) {
    const control = session.control;
    for (const viewer of members(session))
      send(viewer, {
        type: "control",
        yours: control.owner === viewer.id,
        owner: control.owner
          ? (viewers.get(control.owner)?.identity.name ?? "Another user")
          : null,
        viewers: session.references,
      });
  }
  function remove(viewer: Viewer) {
    if (!viewers.delete(viewer.id)) return;
    const session = viewer.session;
    session.control.release(viewer.id);
    viewer.peer?.close();
    viewer.socket.close();
    pool.release(session);
    broadcastControl(session);
    updateStream(session);
    updateBitrate(session);
  }
  function updateStream(session: StudioSession) {
    const enabled = members(session).some(
      (viewer) => viewer.visible && viewer.peer,
    );
    if (enabled === streaming.has(session)) return;
    if (enabled) streaming.add(session);
    else streaming.delete(session);
    session.host.send({ type: "stream", enabled });
  }
  function keyframe(session: StudioSession) {
    if (Date.now() - session.lastKeyframe < 500) return;
    session.lastKeyframe = Date.now();
    session.host.send({ type: "keyframe" });
  }
  function updateBitrate(session: StudioSession) {
    const bitrate = Math.min(
      config.bitrate,
      ...members(session)
        .filter((viewer) => viewer.visible)
        .map((viewer) => viewer.targetBitrate),
    );
    if (bitrate !== session.lastBitrate) {
      session.lastBitrate = bitrate;
      session.host.send({ type: "bitrate", value: bitrate });
    }
  }
  async function input(viewer: Viewer, message: Input) {
    if (!viewers.has(viewer.id)) return;
    const session = viewer.session;
    const control = session.control;
    if (message.type === "visibility") {
      if (viewer.visible === message.visible) return;
      viewer.visible = message.visible;
      viewer.qualityAt = 0;
      viewer.targetBitrate = config.bitrate;
      if (!viewer.visible) control.release(viewer.id);
      updateStream(session);
      updateBitrate(session);
      viewer.peer?.setViewing(viewer.visible);
      return;
    }
    if (!viewer.visible) return;
    if (message.type === "quality") {
      if (Date.now() - viewer.qualityAt < 1800) return;
      viewer.qualityAt = Date.now();
      const impaired = message.loss > 0.03 || message.delay > 0.15;
      viewer.targetBitrate = Math.max(
        300_000,
        Math.min(
          config.bitrate,
          Math.round(viewer.targetBitrate * (impaired ? 0.75 : 1.05)),
        ),
      );
      updateBitrate(session);
      return;
    }
    if (message.type === "select-device") {
      if (control.owner !== viewer.id || config.testPattern) return;
      try {
        const template = (await catalog()).find(
          (device) => device.udid === message.udid,
        );
        if (
          template &&
          (!viewer.minimumOS || compatibleDevice(template, viewer.minimumOS)) &&
          viewers.has(viewer.id)
        )
          await session.select(viewer.id, template);
      } catch {
        send(viewer, { type: "error", message: "Could not prepare simulator" });
      }
      return;
    }
    control.receive(viewer.id, message, session.status);
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    try {
      const identity = await authenticate(request);
      if (
        options.previews &&
        (await previewRoute(request, response, options.previews, config.origin))
      )
        return;
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      const path = new URL(request.url ?? "/", config.origin).pathname;
      if (path === "/api/session") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            name: identity.name,
            previewEnabled: !!options.previews,
            demo: options.previews?.config.demo ?? false,
            turnConfigured: !!config.turnKeyID,
            relayOnly: config.relayOnly,
            maxViewers: config.maxPeers,
            maxSessions: config.maxSessions,
            defaultDevice: config.device,
          }),
        );
        return;
      }
      if (path === "/api/devices") {
        response.setHeader("Content-Type", "application/json");
        try {
          const ref = buildReference(
            new URL(request.url!, config.origin).searchParams.get("build") ??
              "",
          );
          const build =
            options.previews && ref ? options.previews.get(ref) : undefined;
          if (options.previews && !build)
            throw new Error("Open a prepared build first");
          const devices = config.testPattern ? [] : await catalog();
          response.end(
            JSON.stringify({
              devices: build
                ? devices.filter((device) =>
                    compatibleDevice(device, build.minimumOS),
                  )
                : devices,
            }),
          );
        } catch {
          response
            .writeHead(503)
            .end(
              JSON.stringify({
                error:
                  "Could not list simulators. Check Xcode on the host Mac.",
              }),
            );
        }
        return;
      }
      const asset =
        assets[path] ?? (buildReference(path) ? assets["/"] : undefined);
      if (!asset) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(
        new URL(`../web/${asset[0]}`, import.meta.url),
      );
      response.setHeader("Content-Type", asset[1]);
      response.end(body);
    } catch {
      response
        .writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
        .end(
          "Access denied. Sign in through your organization’s Simulator Preview address.",
        );
    }
  }

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", config.origin);
    if (
      closing ||
      url.pathname !== "/session" ||
      request.headers.origin !== config.origin ||
      viewers.size + pendingUpgrades >= config.maxPeers
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    pendingUpgrades++;
    void authenticate(request)
      .then(async (identity) => {
        if (closing || socket.destroyed) return;
        const ref = buildReference(url.searchParams.get("build") ?? "");
        const build = options.previews
          ? ref
            ? options.previews.get(ref)
            : undefined
          : undefined;
        if (options.previews && !build)
          throw new Error("A prepared build is required");
        const baseKey = sessionKey(
          config.accessIssuer ?? "local",
          identity.id,
          url.searchParams.get("client") ?? "",
          url.searchParams.get("workspace") ?? "main",
        );
        const key = build
          ? createHash("sha256")
              .update(
                `${baseKey}:${build.repository}:${build.run}:${build.artifact}`,
              )
              .digest("hex")
          : baseKey;
        const session = await pool.acquire(
          key,
          build
            ? { appPath: build.appPath, bundleID: build.bundleID }
            : undefined,
        );
        if (closing || socket.destroyed) {
          if (session) pool.release(session);
          return;
        }
        if (!session) {
          wsServer.handleUpgrade(request, socket, head, (ws) => {
            ws.send(
              JSON.stringify({
                type: "waiting",
                message:
                  "All simulators are in use. Waiting for an available session…",
              }),
            );
            ws.close(1013, "Simulator capacity reached");
          });
          return;
        }
        let accepted = false;
        try {
          wsServer.handleUpgrade(request, socket, head, (ws) => {
            accepted = true;
            const viewer: Viewer = {
              id: randomUUID(),
              minimumOS: build?.minimumOS,
              identity,
              session,
              socket: ws,
              alive: true,
              created: Date.now(),
              qualityAt: 0,
              targetBitrate: config.bitrate,
              visible: false,
            };
            viewers.set(viewer.id, viewer);
            ws.on("close", () => remove(viewer));
            ws.on("error", () => remove(viewer));
            ws.on("pong", () => {
              viewer.alive = true;
            });
            let signalCount = 0;
            ws.on("message", (raw) => {
              if (++signalCount > 150) {
                remove(viewer);
                return;
              }
              try {
                viewer.peer?.accept(JSON.parse(raw.toString()));
              } catch {
                remove(viewer);
              }
            });
            send(viewer, session.status);
            broadcastControl(session);
            void Promise.all([iceServers(config), iceServers(config)])
              .then(([browserICE, hostICE]) => {
                if (!viewers.has(viewer.id)) return;
                send(viewer, {
                  type: "configuration",
                  iceServers: browserICE,
                  relayOnly: config.relayOnly,
                });
                viewer.peer = new ViewerPeer(
                  viewer.id,
                  config,
                  hostICE,
                  (message) => send(viewer, message),
                  (message) => {
                    void input(viewer, message);
                  },
                  () => keyframe(session),
                  () => remove(viewer),
                );
              })
              .catch(() => {
                send(viewer, {
                  type: "error",
                  message:
                    "Could not prepare WebRTC. Check the host TURN configuration.",
                });
                remove(viewer);
              });
          });
        } finally {
          if (!accepted) pool.release(session);
        }
      })
      .catch(() =>
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"),
      )
      .finally(() => {
        pendingUpgrades--;
      });
  });

  const timer = setInterval(() => {
    for (const session of pool.sessions.values()) session.control.tick();
    void pool
      .sweep()
      .catch((error) =>
        console.error(
          "Session cleanup failed; automatic retry in 30 seconds:",
          error,
        ),
      );
    for (const viewer of viewers.values()) {
      if (
        Date.now() >=
          Math.min(viewer.identity.expiresAt, viewer.created + 7 * 3600_000) ||
        (Date.now() - viewer.created > 30_000 && !viewer.peer?.isConnected())
      )
        remove(viewer);
    }
  }, 1000);
  const heartbeat = setInterval(() => {
    for (const viewer of viewers.values()) {
      if (!viewer.alive) {
        viewer.socket.terminate();
        remove(viewer);
      } else {
        viewer.alive = false;
        viewer.socket.ping();
      }
    }
  }, 5000);

  return {
    server,
    pool,
    ready: pool.ready,
    async close() {
      closing = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      for (const viewer of [...viewers.values()]) remove(viewer);
      wsServer.close();
      server.closeAllConnections();
      await Promise.all([
        pool.close(),
        options.previews?.close(),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
    },
  };
}

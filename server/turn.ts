import type { IceServer } from "node-datachannel";
import type { Config } from "./config.js";

export interface BrowserIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export async function iceServers(
  config: Config,
  request = fetch,
): Promise<BrowserIceServer[]> {
  if (!config.turnKeyID) return [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  const response = await request(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.turnKeyID)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.turnToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 8 * 3600 }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new Error(`TURN credential service returned ${response.status}`);
  const result = (await response.json()) as {
    iceServers?: BrowserIceServer | BrowserIceServer[];
  };
  const servers = Array.isArray(result.iceServers)
    ? result.iceServers
    : [result.iceServers];
  if (
    !servers.length ||
    servers.some(
      (s) =>
        !s ||
        !Array.isArray(s.urls) ||
        !s.urls.length ||
        s.urls.some(
          (url) => typeof url !== "string" || !/^(stun|turn|turns):/.test(url),
        ),
    )
  ) {
    throw new Error("Invalid TURN credential response");
  }
  return servers as BrowserIceServer[];
}

export function nativeIceServers(
  servers: BrowserIceServer[],
): (IceServer | string)[] {
  return servers.flatMap((server) =>
    server.urls.map((url) => {
      if (url.startsWith("stun:")) return url;
      const match = /^(turns?):([^:?]+):(\d+)(?:\?transport=(udp|tcp))?$/.exec(
        url,
      );
      if (!match || !server.username || !server.credential)
        throw new Error("Invalid TURN server");
      return {
        hostname: match[2]!,
        port: Number(match[3]),
        username: server.username,
        password: server.credential,
        relayType:
          match[1] === "turns"
            ? "TurnTls"
            : match[4] === "tcp"
              ? "TurnTcp"
              : "TurnUdp",
      } as IceServer;
    }),
  );
}

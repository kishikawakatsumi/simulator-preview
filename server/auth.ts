import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

export interface Identity {
  id: string;
  name: string;
  expiresAt: number;
}

export function createAuthenticator(config: Config) {
  const keys = config.accessIssuer
    ? createRemoteJWKSet(new URL(`${config.accessIssuer}/cdn-cgi/access/certs`))
    : undefined;
  return async (request: IncomingMessage): Promise<Identity> => {
    if (request.headers.host !== new URL(config.origin).host)
      throw new Error("Invalid host");
    if (request.headers.origin && request.headers.origin !== config.origin)
      throw new Error("Invalid origin");
    if (config.mode === "local") {
      if (
        !["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(
          request.socket.remoteAddress ?? "",
        ) ||
        request.headers["cf-connecting-ip"] ||
        request.headers["x-forwarded-for"]
      )
        throw new Error("Local access only");
      return {
        id: "local",
        name: "Local user",
        expiresAt: Date.now() + 8 * 3600_000,
      };
    }
    const token = request.headers["cf-access-jwt-assertion"];
    if (typeof token !== "string" || !keys)
      throw new Error("Access authentication required");
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.accessIssuer,
      audience: config.accessAudience,
      algorithms: ["RS256"],
    });
    if (!payload.sub || !payload.exp || typeof payload.email !== "string")
      throw new Error("A user identity is required");
    return {
      id: payload.sub,
      name: payload.email,
      expiresAt: payload.exp * 1000,
    };
  };
}

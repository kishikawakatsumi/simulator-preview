import type { IncomingMessage, ServerResponse } from "node:http";
import { buildReference, PreviewError } from "./config.js";
import type { PreviewStore } from "./store.js";
export async function previewRoute(
  request: IncomingMessage,
  response: ServerResponse,
  store: PreviewStore,
  origin: string,
) {
  const path = new URL(request.url ?? "/", origin).pathname;
  if (!path.startsWith("/api/builds/")) return false;
  response.setHeader("Content-Type", "application/json");
  try {
    const ref = buildReference(path.slice(4));
    if (!ref) throw new PreviewError(404, "Invalid build URL.");
    if (request.method === "POST") {
      if (
        request.headers.origin !== origin ||
        request.headers["x-preview-request"] !== "1"
      )
        throw new PreviewError(403, "Invalid preview request origin.");
      if (
        Number(request.headers["content-length"] ?? 0) !== 0 ||
        request.headers["transfer-encoding"]
      )
        throw new PreviewError(400, "This request must not contain a body.");
      response.writeHead(202).end(JSON.stringify(store.start(ref)));
    } else if (request.method === "GET")
      response.end(JSON.stringify(store.status(ref)));
    else
      response
        .writeHead(405, { Allow: "GET, POST" })
        .end(JSON.stringify({ error: "Method not allowed" }));
  } catch (error) {
    response
      .writeHead(error instanceof PreviewError ? error.status : 500)
      .end(
        JSON.stringify({
          error:
            error instanceof PreviewError
              ? error.message
              : "Preview request failed.",
        }),
      );
  }
  return true;
}

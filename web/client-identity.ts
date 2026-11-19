const key = "simulator-preview.client";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identifies this browser's storage, not the physical hardware and never the signed-in user. */
export function clientIdentity(storage?: Pick<Storage, "getItem" | "setItem">) {
  try {
    storage ??= localStorage;
  } catch {
    /* Storage may be disabled. */
  }
  let client: string | null = null;
  try {
    client = storage?.getItem(key) ?? null;
  } catch {
    /* Restricted storage: retain identity for this page. */
  }
  if (client && uuid.test(client)) return client;
  client = crypto.randomUUID();
  try {
    storage?.setItem(key, client);
  } catch {
    /* A reload may create a new session in this browser. */
  }
  return client;
}
export function workspaceIdentity(url: URL) {
  const workspace = url.searchParams.get("workspace");
  return workspace && uuid.test(workspace) ? workspace : "main";
}
export function additionalWorkspaceURL(url: URL) {
  const next = new URL(url);
  next.searchParams.set("workspace", crypto.randomUUID());
  return next.href;
}

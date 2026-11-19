import test from "node:test";
import assert from "node:assert/strict";
import { ControlLease } from "../dist/server/control.js";
import { HostDecoder, parseInput } from "../dist/server/protocol.js";
import { readConfig } from "../dist/server/config.js";
import { createAuthenticator } from "../dist/server/auth.js";
import { iceServers, nativeIceServers } from "../dist/server/turn.js";
import { normalizedPoint } from "../dist/web/input.js";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const ready = { ready: true, revision: 3, busy: false, switching: false };
const pointer = (phase = "down", revision = 3) => ({
  type: "pointer",
  phase,
  revision,
  x: 0.25,
  y: 0.75,
});

test("viewer input is denied; owner disconnect releases a held touch", () => {
  const sent = [];
  const lease = new ControlLease(
    (command) => sent.push(command),
    () => {},
  );
  assert.equal(lease.receive("viewer", pointer(), ready), false);
  lease.receive("owner", { type: "claim" }, ready);
  lease.receive("owner", pointer(), ready);
  assert.deepEqual(sent, [pointer()]);
  lease.release("owner");
  assert.equal(sent.at(-1).type, "release");
  assert.equal(lease.owner, null);
});

test("rotation invalidates old coordinates and a move cannot begin a gesture", () => {
  const sent = [];
  const lease = new ControlLease(
    (c) => sent.push(c),
    () => {},
  );
  lease.receive("a", { type: "claim" }, ready);
  assert.equal(lease.receive("a", pointer("move"), ready), false);
  lease.receive("a", pointer(), ready);
  assert.equal(
    lease.receive("a", pointer("move"), { ...ready, revision: 4 }),
    false,
  );
  assert.equal(sent.at(-1).type, "release");
  assert.equal(
    lease.receive("a", pointer("up", 4), { ...ready, revision: 4 }),
    false,
  );
});

test("a healthy foreground tab retains control while idle; missing heartbeats release it", () => {
  let now = 0;
  const lease = new ControlLease(
    () => {},
    () => {},
    () => now,
  );
  lease.receive("a", { type: "claim" }, ready);
  for (now = 2000; now <= 600000; now += 2000) {
    lease.receive("a", { type: "heartbeat" }, ready);
    lease.tick();
    assert.equal(lease.owner, "a");
  }
  now += 7100;
  lease.tick();
  assert.equal(lease.owner, null);
});

test("foreground handoff is atomic and releases the old tabs held touch", () => {
  const sent = [],
    owners = [];
  const lease = new ControlLease(
    (c) => sent.push(c),
    () => owners.push(lease.owner),
  );
  lease.receive("first", { type: "claim" }, ready);
  lease.receive("first", pointer(), ready);
  lease.receive("second", { type: "claim" }, ready);
  assert.deepEqual(owners, ["first", "second"]);
  assert.equal(sent.at(-1).type, "release");
  assert.equal(lease.receive("first", pointer("move"), ready), false);
  assert.equal(lease.receive("second", pointer(), ready), true);
  lease.release("first");
  assert.equal(lease.owner, "second");
});

test("binary host framing handles one-byte chunks, multiple messages, and RTP timestamp wrap", () => {
  const status = Buffer.from(JSON.stringify({ type: "status", revision: 7 }));
  const frame = Buffer.alloc(22);
  frame[0] = 2;
  frame.writeUInt32BE(7, 1);
  frame.writeBigUInt64BE(60_000_000_000n, 5);
  frame[13] = 1;
  frame.writeUInt16BE(640, 14);
  frame.writeUInt16BE(960, 16);
  frame.set([0, 0, 1, 5], 18);
  const wrap = (body) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    return Buffer.concat([size, body]);
  };
  const values = [];
  const decoder = new HostDecoder(
    (value) => values.push(value),
    (value) => values.push(value),
  );
  for (const byte of Buffer.concat([
    wrap(Buffer.concat([Buffer.from([1]), status])),
    wrap(frame),
  ]))
    decoder.push(Buffer.from([byte]));
  assert.equal(values.length, 2);
  assert.equal(values[1].revision, 7);
  assert.equal(values[1].width, 640);
  assert.equal(values[1].timestamp, Number(5_400_000_000n % 0x100000000n));
  assert.deepEqual(values[1].data, Buffer.from([0, 0, 1, 5]));
  assert.throws(
    () =>
      new HostDecoder(
        () => {},
        () => {},
      ).push(Buffer.from([255, 255, 255, 255])),
    /size/,
  );
});

test("untrusted input rejects invalid coordinates, revisions and commands", () => {
  for (const value of [
    null,
    [],
    { type: "shutdown" },
    { ...pointer(), x: -1 },
    { ...pointer(), x: "0.2" },
    { ...pointer(), revision: 1.2 },
    { type: "quality", loss: 2, delay: 0 },
    { type: "visibility", visible: "false" },
    { type: "visibility", visible: 0 },
    { type: "visibility" },
    { type: "select-device", udid: "../../a" },
  ]) {
    assert.equal(parseInput(JSON.stringify(value)), null);
  }
  assert.deepEqual(parseInput(JSON.stringify(pointer())), pointer());
  for (const visible of [true, false])
    assert.deepEqual(
      parseInput(JSON.stringify({ type: "visibility", visible })),
      {
        type: "visibility",
        visible,
      },
    );
});

test("aspect-fit coordinates exclude letterboxing and clamp a captured drag", () => {
  const rect = { left: 10, top: 20, width: 1000, height: 1000 };
  assert.equal(normalizedPoint(rect, 500, 1000, 20, 520, false), null);
  assert.deepEqual(normalizedPoint(rect, 500, 1000, 510, 520, false), {
    x: 0.5,
    y: 0.5,
  });
  assert.deepEqual(normalizedPoint(rect, 500, 1000, 0, 2000, true), {
    x: 0,
    y: 1,
  });
});

test("public origin cannot accidentally use local authentication", () => {
  assert.throws(
    () => readConfig({ PREVIEW_ORIGIN: "https://sim.example.com" }),
    /Local/,
  );
  assert.throws(() => readConfig({ PREVIEW_AUTH: "access" }), /Public/);
  assert.throws(() => readConfig({ PREVIEW_RELAY_ONLY: "1" }), /TURN/);
  assert.throws(() => readConfig({ PREVIEW_FPS: "NaN" }), /FPS/);
});

test("loopback authentication rejects rebinding, cross-origin and tunnel-forwarded requests", async () => {
  const auth = createAuthenticator(readConfig({}));
  const request = {
    headers: { host: "127.0.0.1:8091" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal((await auth(request)).id, "local");
  for (const extra of [
    { host: "evil.example" },
    { origin: "https://evil.example" },
    { "cf-connecting-ip": "1.2.3.4" },
    { "x-forwarded-for": "1.2.3.4" },
  ]) {
    await assert.rejects(
      auth({ ...request, headers: { ...request.headers, ...extra } }),
    );
  }
  const publicAuth = createAuthenticator(
    readConfig({
      PREVIEW_AUTH: "access",
      PREVIEW_ORIGIN: "https://sim.example.com",
      CF_ACCESS_ISSUER: "https://company.cloudflareaccess.com",
      CF_ACCESS_AUD: "test",
    }),
  );
  await assert.rejects(
    publicAuth({
      ...request,
      headers: {
        host: "sim.example.com",
        "cf-access-authenticated-user-email": "fake@example.com",
      },
    }),
  );
});

test("TURN secrets stay in backend requests and issued credentials map to native ICE", async () => {
  const config = readConfig({
    CF_TURN_KEY_ID: "key",
    CF_TURN_API_TOKEN: "secret",
  });
  const servers = await iceServers(config, async (url, init) => {
    assert.equal(
      url,
      "https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers",
    );
    assert.equal(init.headers.Authorization, "Bearer secret");
    assert.equal(JSON.parse(init.body).ttl, 28800);
    return Response.json({
      iceServers: {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "short-user",
        credential: "short-password",
      },
    });
  });
  assert.ok(!JSON.stringify(servers).includes("secret"));
  assert.deepEqual(
    nativeIceServers(servers).map((s) => s.relayType),
    ["TurnUdp", "TurnTls"],
  );
  await assert.rejects(
    iceServers(config, async () => Response.json({ iceServers: [] })),
    /Invalid/,
  );
  await assert.rejects(
    iceServers(config, async () => new Response("", { status: 401 })),
    /401/,
  );
});

test("Access verifies signature, audience, issuer and expiry against JWKS", async (t) => {
  const issuer = "https://company.cloudflareaccess.com";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  });
  const auth = createAuthenticator(
    readConfig({
      PREVIEW_AUTH: "access",
      PREVIEW_ORIGIN: "https://sim.example.com",
      CF_ACCESS_ISSUER: issuer,
      CF_ACCESS_AUD: "studio",
    }),
  );
  const token = async (
    audience = "studio",
    expires = "1h",
    tokenIssuer = issuer,
    key = privateKey,
  ) =>
    new SignJWT({ email: "member@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("member")
      .setIssuer(tokenIssuer)
      .setAudience(audience)
      .setExpirationTime(expires)
      .sign(key);
  const request = (jwt) => ({
    headers: { host: "sim.example.com", "cf-access-jwt-assertion": jwt },
    socket: { remoteAddress: "127.0.0.1" },
  });
  assert.equal((await auth(request(await token()))).id, "member");
  for (const jwt of [
    await token("another-app"),
    await token("studio", "-1s"),
    await token("studio", "1h", "https://another.cloudflareaccess.com"),
    await token(
      "studio",
      "1h",
      issuer,
      (await generateKeyPair("RS256")).privateKey,
    ),
  ]) {
    await assert.rejects(auth(request(jwt)));
  }
});

test("startup video never grants input, and stale preview coordinates remain invalid after boot", () => {
  const sent = [];
  const lease = new ControlLease(
    (command) => sent.push(command),
    () => {},
  );
  const preview = {
    ...ready,
    connected: false,
    preview: true,
    ready: false,
    busy: true,
    switching: true,
  };
  lease.receive("owner", { type: "claim" }, preview);
  assert.equal(lease.receive("owner", pointer(), preview), false);
  assert.equal(
    lease.receive("owner", { type: "action", action: "home" }, preview),
    false,
  );
  assert.deepEqual(sent, []);
  const booted = { ...ready, revision: 4 };
  assert.equal(lease.receive("owner", pointer(), booted), false);
  assert.equal(lease.receive("owner", pointer("down", 4), booted), true);
});

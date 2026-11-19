import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import {
  buildReference,
  previewConfig,
} from "../dist/server/preview/config.js";
import { GitHubBuilds } from "../dist/server/preview/github.js";
import { compatibleDevice } from "../dist/server/preview/compatibility.js";
import { SessionPool } from "../dist/server/sessions.js";
import { readConfig } from "../dist/server/config.js";
import { previewRoute } from "../dist/server/preview/routes.js";

const config = previewConfig({
  PREVIEW_REPOSITORY: "owner/repo",
  GITHUB_TOKEN: "test-secret",
});
const ref = buildReference("/builds/12/34");
function fixtures() {
  return {
    run: {
      id: 12,
      repository: { id: 5, full_name: "owner/repo" },
      head_repository: { full_name: "owner/repo" },
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      path: config.workflow,
      head_sha: "a".repeat(40),
      pull_requests: [{ number: 3 }],
    },
    artifact: {
      id: 34,
      name: "simulator-preview",
      workflow_run: { id: 12, head_sha: "a".repeat(40), head_repository_id: 5 },
      digest: `sha256:${"b".repeat(64)}`,
      size_in_bytes: 2000,
      expired: false,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    },
    pr: {
      number: 3,
      title: "Change the UI",
      head: { repo: { full_name: "owner/repo" } },
      base: { repo: { full_name: "owner/repo" } },
    },
  };
}
function github(data) {
  return new GitHubBuilds(config, async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer test-secret");
    const value = url.includes("/actions/runs/")
      ? data.run
      : url.includes("/actions/artifacts/")
        ? data.artifact
        : data.pr;
    return Response.json(value);
  });
}
test("only canonical bounded build identifiers and explicit repository configurations are accepted", () => {
  assert.equal(ref.key, "12-34");
  for (const path of [
    "/builds/0/34",
    "/builds/12/../34",
    "/builds/12/34?repo=evil",
    "/builds/9007199254740999/34",
    "/builds/12/34/extra",
  ])
    assert.equal(buildReference(path), undefined);
  assert.throws(() => previewConfig({}), /PREVIEW_REPOSITORY/);
  assert.throws(
    () => previewConfig({ PREVIEW_DEMO: "1", PREVIEW_AUTH: "access" }),
    /local only/,
  );
});
test("approved successful build resolves immutable metadata", async () => {
  const result = await github(fixtures()).metadata(ref);
  assert.equal(result.sha, "a".repeat(40));
  assert.equal(result.pr, 3);
  assert.equal(result.artifact, "34");
});
for (const [name, mutate, status] of [
  [
    "wrong workflow",
    (d) => {
      d.run.path = ".github/workflows/evil.yml";
    },
    403,
  ],
  [
    "unsuccessful run",
    (d) => {
      d.run.conclusion = "failure";
    },
    403,
  ],
  [
    "fork run",
    (d) => {
      d.run.head_repository.full_name = "stranger/repo";
    },
    403,
  ],
  [
    "cross-run artifact",
    (d) => {
      d.artifact.workflow_run.id = 13;
    },
    403,
  ],
  [
    "wrong commit",
    (d) => {
      d.artifact.workflow_run.head_sha = "c".repeat(40);
    },
    403,
  ],
  [
    "wrong repository",
    (d) => {
      d.artifact.workflow_run.head_repository_id = 99;
    },
    403,
  ],
  [
    "expired artifact",
    (d) => {
      d.artifact.expired = true;
    },
    410,
  ],
  [
    "missing digest",
    (d) => {
      delete d.artifact.digest;
    },
    403,
  ],
  [
    "oversized artifact",
    (d) => {
      d.artifact.size_in_bytes = 1024 ** 3;
    },
    413,
  ],
  [
    "ambiguous PR",
    (d) => {
      d.run.pull_requests.push({ number: 4 });
    },
    403,
  ],
  [
    "fork PR",
    (d) => {
      d.pr.head.repo.full_name = "stranger/repo";
    },
    403,
  ],
])
  test(`rejects ${name}`, async () => {
    const data = fixtures();
    mutate(data);
    await assert.rejects(
      github(data).metadata(ref),
      (error) => error.status === status,
    );
  });
test("download verifies digest and does not send GitHub credentials to artifact storage", async (t) => {
  const directory = await mkdtemp("/private/tmp/preview-download-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("archive");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const api = new GitHubBuilds(config, async (url, options) => {
    if (String(url).startsWith("https://api.github.com/"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://storage.example/build.zip" },
      });
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, "error");
    return new Response(bytes);
  });
  await api.download(ref, `${directory}/ok`, digest);
  assert.deepEqual(await readFile(`${directory}/ok`), bytes);
  await assert.rejects(
    api.download(ref, `${directory}/bad`, "sha256:wrong"),
    /integrity/,
  );
  await assert.rejects(readFile(`${directory}/bad`), { code: "ENOENT" });
});
test("minimum runtime selection compares versions numerically", () => {
  assert(compatibleDevice({ runtime: "iOS 26.3" }, "18.0"));
  assert(compatibleDevice({ runtime: "26.10" }, "26.3"));
  assert(!compatibleDevice({ runtime: "26.2" }, "26.3"));
  assert(!compatibleDevice({ runtime: "watchOS 26.3" }, "18.0"));
});
test("artifact preparation requires authenticated routing plus same-origin explicit POST; GET cannot start it", async () => {
  let starts = 0;
  const store = {
    start() {
      starts++;
      return { state: "preparing" };
    },
    status() {
      return { state: "ready" };
    },
  };
  function response() {
    return {
      code: 200,
      setHeader() {},
      writeHead(code) {
        this.code = code;
        return this;
      },
      end(body) {
        this.body = body;
      },
    };
  }
  for (const headers of [
    {},
    { origin: "http://evil", "x-preview-request": "1" },
    {
      origin: "http://localhost",
      "x-preview-request": "1",
      "content-length": "20",
    },
  ]) {
    const r = response();
    await previewRoute(
      { url: "/api/builds/12/34", method: "POST", headers },
      r,
      store,
      "http://localhost",
    );
    assert(r.code >= 400);
  }
  await previewRoute(
    { url: "/api/builds/12/34", method: "GET", headers: {} },
    response(),
    store,
    "http://localhost",
  );
  assert.equal(starts, 0);
  await previewRoute(
    {
      url: "/api/builds/12/34",
      method: "POST",
      headers: { origin: "http://localhost", "x-preview-request": "1" },
    },
    response(),
    store,
    "http://localhost",
  );
  assert.equal(starts, 1);
});
test("independent sessions pin their own app and reconnect does not change an existing build", async () => {
  class Host extends EventEmitter {
    status = { revision: 0, error: "" };
    start(config) {
      this.config = config;
    }
    send() {}
    async stop() {}
  }
  const pool = new SessionPool(
    readConfig({ PREVIEW_TEST_PATTERN: "1", PREVIEW_MAX_SESSIONS: "2" }),
    { createHost: () => new Host() },
  );
  try {
    const a = await pool.acquire("a", {
      appPath: "/build-A/App.app",
      bundleID: "app.a",
    });
    const b = await pool.acquire("b", {
      appPath: "/build-B/App.app",
      bundleID: "app.b",
    });
    assert.equal(a.host.config.appPath, "/build-A/App.app");
    assert.equal(b.host.config.appPath, "/build-B/App.app");
    assert.equal(
      await pool.acquire("a", { appPath: "/wrong", bundleID: "wrong" }),
      a,
    );
    assert.equal(a.host.config.appPath, "/build-A/App.app");
  } finally {
    await pool.close();
  }
});

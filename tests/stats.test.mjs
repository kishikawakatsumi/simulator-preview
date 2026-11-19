import test from "node:test";
import assert from "node:assert/strict";
import { ReceiverStats } from "../dist/web/stats.js";

test("visibility reset discards in-flight statistics and starts a fresh sample window", async () => {
  const stats = new ReceiverStats();
  const report = (timestamp, framesDecoded) =>
    new Map([
      [
        "video",
        {
          type: "inbound-rtp",
          kind: "video",
          timestamp,
          framesDecoded,
          bytesReceived: framesDecoded * 1000,
          packetsReceived: framesDecoded,
          jitterBufferEmittedCount: framesDecoded,
          jitterBufferDelay: framesDecoded * 0.01,
        },
      ],
    ]);
  let next = report(1000, 10);
  const peer = { getStats: () => Promise.resolve(next) };
  assert.equal(await stats.read(peer), null);
  let finish;
  next = new Promise((resolve) => (finish = resolve));
  const pending = stats.read(peer);
  stats.reset(); // The page hides, then returns before the old getStats completes.
  finish(report(2000, 20));
  assert.equal(await pending, null);
  next = report(100000, 30);
  assert.equal(
    await stats.read(peer),
    null,
    "the hidden interval is not a quality sample",
  );
  next = report(101000, 40);
  const metrics = await stats.read(peer);
  assert.equal(metrics.fps, 10);
  assert.equal(metrics.mbps, 0.08);
  assert.equal(metrics.loss, 0);
});

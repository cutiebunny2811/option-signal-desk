import test from "node:test";
import assert from "node:assert/strict";
import { assessChart, shouldAlert } from "../supabase/functions/_shared/monitor-signal.mjs";

function chart(now, direction = 1) {
  const start = Math.floor((now - 130 * 60_000) / 60_000) * 60_000;
  const bars = Array.from({ length: 130 }, (_, i) => {
    const close = 100 + direction * i * 0.05;
    return { time: new Date(start + i * 60_000).toISOString(), open: close - direction * 0.02,
      high: close + 0.04, low: close - 0.04, close, volume: 1000 };
  });
  return { bars, fetched_at: new Date(now).toISOString(), stale: false };
}

test("closed 1m bars yield the same early/aligned direction tiers", () => {
  const now = Date.parse("2026-10-27T15:00:30Z");
  assert.equal(assessChart(chart(now, 1), now).direction, "up");
  assert.equal(assessChart(chart(now, -1), now).direction, "down");
  assert.equal(assessChart({ ...chart(now), stale: true }, now).fresh, false);
});

test("only a new completed bar and direction transition can notify", () => {
  const next = { direction: "up", fresh: true, asOf: 2000 };
  assert.equal(shouldAlert({ direction: "wait", fresh: true, as_of: 1000 }, next), true);
  assert.equal(shouldAlert({ direction: "up", fresh: true, as_of: 1000 }, next), false);
  assert.equal(shouldAlert({ direction: "wait", fresh: true, as_of: 2000 }, next), false);
  assert.equal(shouldAlert({ direction: "wait", fresh: false, as_of: 1000 }, next), false);
});

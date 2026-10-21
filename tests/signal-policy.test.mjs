import test from "node:test";
import assert from "node:assert/strict";
import policy from "../signal-policy.js";

const trend = (direction, changes = {}) => ({ direction, usable: true, stale: false, closed: false, ...changes });

test("two fresh short frames give an early watch without waiting for the hour", () => {
  assert.deepEqual(policy.assess({ M1: trend("up"), M5: trend("up"), M15: trend("wait"), M60: trend("down", { stale: true }) }),
    { direction: "up", tier: "early", fresh: true, up: 2, down: 0 });
  assert.equal(policy.assess({ M1: trend("down"), M5: trend("down") }).tier, "early");
});

test("fresh 15m alignment upgrades to 3/3; opposition blocks", () => {
  assert.equal(policy.assess({ M1: trend("up"), M5: trend("up"), M15: trend("up") }).tier, "aligned");
  const opposed = policy.assess({ M1: trend("up"), M5: trend("up"), M15: trend("down") });
  assert.equal(opposed.direction, "wait");
  assert.equal(opposed.opposed, true);
});

test("stale 1m or 5m and closed market never produce a directional watch", () => {
  assert.equal(policy.assess({ M1: trend("up", { stale: true }), M5: trend("up") }).direction, "wait");
  assert.equal(policy.assess({ M1: trend("up"), M5: trend("up", { usable: false }) }).direction, "wait");
  assert.equal(policy.assess({ M1: trend("up"), M5: trend("up") }, false).direction, "wait");
});

test("historical 1h candle context is descriptive only", () => {
  const up = [10, 10.3, 10.5, 10.8].map((close) => ({ open: close - .1, close }));
  assert.equal(policy.priceActionContext(up).direction, "up");
  assert.equal(policy.priceActionContext(up.slice(2)).direction, "wait");
  const mixed = [10, 10.3, 10.1, 10.4].map((close) => ({ open: 10.2, close }));
  assert.equal(policy.priceActionContext(mixed).direction, "wait");
});

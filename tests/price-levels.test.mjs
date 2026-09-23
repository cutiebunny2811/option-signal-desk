import test from "node:test";
import assert from "node:assert/strict";
import levels from "../price-levels.js";

function bars(direction = 1) {
  return Array.from({ length: 40 }, (_, index) => {
    const close = 100 + direction * index * .1;
    return { time: 1_700_000_000 + index * 300, high: close + .2, low: close - .2, close };
  });
}

test("EMA weights recent closes and ATR measures the true range", () => {
  assert.deepEqual(levels.ema([10, 12, 14], 3), [10, 11, 12.5]);
  const flat = Array.from({ length: 20 }, (_, index) => ({ high: 102, low: 98, close: index === 0 ? 100 : 101 }));
  assert.equal(levels.atr(flat), 4);
  const gap = [...flat];
  gap[1] = { high: 106, low: 104, close: 105 };
  assert.ok(levels.atr(gap) > 4);
});

test("up scenario places stop below entry and targets at 1R and 1.8R", () => {
  const plan = levels.calculate(bars(1), "up");
  assert.ok(plan);
  assert.ok(plan.entry > bars(1).at(-1).high);
  assert.ok(plan.stop < plan.entry);
  assert.equal(plan.tp1, +(plan.entry + plan.risk).toFixed(2));
  assert.ok(Math.abs((plan.tp2 - plan.entry) / plan.risk - 1.8) < .02);
  assert.equal(plan.timeframe, "5m");
});

test("down scenario reverses the entry, stop and targets", () => {
  const sample = bars(-1);
  const plan = levels.calculate(sample, "down");
  assert.ok(plan);
  assert.ok(plan.entry < sample.at(-1).low);
  assert.ok(plan.stop > plan.entry);
  assert.equal(plan.tp1, +(plan.entry - plan.risk).toFixed(2));
  assert.ok(Math.abs((plan.entry - plan.tp2) / plan.risk - 1.8) < .02);
});

test("missing, invalid or excessively wide setups fail closed", () => {
  assert.equal(levels.calculate(bars().slice(0, 20), "up"), null);
  assert.equal(levels.calculate(bars(), "wait"), null);
  const bad = bars(); bad[20].high = Number.NaN;
  assert.equal(levels.calculate(bad, "up"), null);
  const wide = bars(); wide[39].high += 20;
  assert.equal(levels.calculate(wide, "up"), null);
});

test("wide but measurable risk stays visible as an unconfirmed reference", () => {
  const sample = bars(); sample[39].high += 5;
  const plan = levels.calculate(sample, "up");
  assert.ok(plan);
  assert.equal(plan.wideRisk, true);
});

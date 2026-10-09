import test from "node:test";
import assert from "node:assert/strict";
import vwap from "../session-vwap.js";

const start = Date.UTC(2026, 9, 9, 13, 30) / 1000; // 09:30 New York during daylight saving time.
const bar = (minute, high, low, close, volume) => ({ time: start + minute * 60, high, low, close, volume });

test("session VWAP uses only closed regular-session bars and resets at the New York open", () => {
  const premarket = bar(-1, 200, 200, 200, 1000);
  const bars = [premarket, bar(0, 101, 99, 100, 100), bar(1, 102, 100, 101, 200), bar(2, 103, 101, 102, 100)];
  const result = vwap.calculate(bars, "2026-10-09");
  assert.equal(result.ready, true);
  assert.equal(result.bars, 3);
  assert.equal(result.value, 101);
  assert.equal(result.byTime[start], 100);
  assert.equal(vwap.check(result, "up", bars.at(-1)).ok, true);
  assert.equal(vwap.check(result, "down", bars.at(-1)).ok, false);
});

test("missing open, a minute gap, or invalid volume fails closed", () => {
  assert.equal(vwap.calculate([bar(1, 102, 100, 101, 200)], "2026-10-09").ready, false);
  assert.match(vwap.calculate([bar(0, 101, 99, 100, 100), bar(2, 103, 101, 102, 100)], "2026-10-09").reason, /ขาดช่วง/);
  assert.match(vwap.calculate([bar(0, 101, 99, 100, 0)], "2026-10-09").reason, /volume/);
  assert.equal(vwap.calculate([bar(0, 101, 99, 100, 100)], "2026-10-10").ready, false);
});

test("New York session anchor follows daylight-saving changes", () => {
  const winterOpen = Date.UTC(2026, 11, 1, 14, 30) / 1000;
  assert.deepEqual(vwap.sessionTime(winterOpen), { date: "2026-12-01", minute: 570 });
  assert.equal(vwap.calculate([{ time: winterOpen, high: 10.2, low: 9.8, close: 10, volume: 500 }], "2026-12-01").ready, true);
});

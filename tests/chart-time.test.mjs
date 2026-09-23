import test from "node:test";
import assert from "node:assert/strict";
import chartTime from "../chart-time.js";

const at = (value) => Date.parse(value);
const candle = (value) => ({ time: at(value) / 1000, open: 10, high: 11, low: 9, close: 10.5 });

test("a cached partial 1m candle does not become complete as the clock advances", () => {
  const bar = candle("2026-09-23T18:00:00Z");
  assert.deepEqual(chartTime.completedBars([bar], "M1", "2026-09-23T18:00:30Z", at("2026-09-23T18:03:00Z")), []);
  assert.equal(chartTime.completedBars([bar], "M1", "2026-09-23T18:01:10Z", at("2026-09-23T18:03:00Z")).length, 1);
});

test("4h last regular-session bar closes at New York market close only from a post-close fetch", () => {
  const bar = candle("2026-09-23T17:30:00Z"); // 13:30 ET; regular session ends at 20:00Z.
  assert.equal(chartTime.barEndMs(bar, "M240"), at("2026-09-23T20:00:00Z"));
  assert.equal(chartTime.completedBars([bar], "M240", "2026-09-23T20:05:00Z", at("2026-09-23T20:20:00Z")).length, 0);
  assert.equal(chartTime.completedBars([bar], "M240", "2026-09-23T20:12:00Z", at("2026-09-23T20:20:00Z")).length, 1);
});

test("a same-day daily bar remains open until the source was fetched after settlement", () => {
  const today = candle("2026-09-23T12:00:00Z");
  const yesterday = candle("2026-09-22T00:00:00Z");
  assert.equal(chartTime.dailySessionKey(today.time), "2026-09-23");
  assert.equal(chartTime.dailySessionKey(yesterday.time), "2026-09-22");
  assert.deepEqual(chartTime.completedBars([yesterday, today], "D", "2026-09-23T19:00:00Z", at("2026-09-24T18:00:00Z")), [yesterday]);
  assert.deepEqual(chartTime.completedBars([yesterday, today], "D", "2026-09-23T20:12:00Z", at("2026-09-23T20:20:00Z")), [yesterday, today]);
});

test("chart clock labels are Bangkok time without shifting the underlying UTC timestamp", () => {
  const time = at("2026-09-23T18:00:00Z") / 1000;
  assert.equal(chartTime.axisTick(time, 3), "01:00");
  assert.match(chartTime.formatBangkok(time), /01:00/);
  assert.equal(chartTime.axisTick(time, 2), "24/09");
});

test("missing fetch timestamp fails closed", () => {
  assert.deepEqual(chartTime.completedBars([candle("2026-09-23T18:00:00Z")], "M1", null), []);
});

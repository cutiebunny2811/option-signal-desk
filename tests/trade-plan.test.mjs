import test from "node:test";
import assert from "node:assert/strict";
import tracker from "../trade-plan.js";

const NOW = Date.UTC(2026, 8, 23, 14);
const contract = (changes = {}) => ({ symbol: "ONDS-C10", bid: .95, ask: 1.03, volume: 40, open_interest: 500, quote_time: new Date(NOW).toISOString(), ...changes });
const candidate = (changes = {}) => ({ direction: "up", entry: 10, stop: 9.8, tp1: 10.2, tp2: 10.36, risk: .2, basedOn: 900, wideRisk: false, ...changes });
const bar = (time, open, high, low, close) => ({ time, open, high, low, close });
const context = (changes = {}) => ({
  symbol: "ONDS", sessionKey: "2026-09-23", candidate: candidate(), confirmed: true,
  marketOpen: true, chartFresh: true, contract: contract(),
  bars: [bar(1000, 9.9, 9.95, 9.88, 9.92)], now: NOW, ...changes
});

test("locks a setup and ignores historical touches before arming", () => {
  const prior = bar(940, 9.9, 10.1, 9.85, 9.91);
  const { plan } = tracker.reconcile(null, context({ bars: [prior, context().bars[0]] }));
  assert.equal(plan.status, "armed");
  assert.equal(plan.entry, 10);
  assert.equal(plan.lastSeenBarTime, 1000);
  assert.equal(plan.contractSymbol, "ONDS-C10");
});

test("only a new, completed one-minute close through entry triggers; levels stay locked", () => {
  const armed = tracker.reconcile(null, context()).plan;
  const wick = bar(1060, 9.92, 10.02, 9.90, 9.98);
  const waiting = tracker.reconcile(armed, context({ bars: [...context().bars, wick], candidate: candidate({ entry: 10.1 }) })).plan;
  assert.equal(waiting.status, "armed");
  assert.equal(waiting.entry, 10);
  const close = bar(1120, 9.98, 10.04, 9.96, 10.02);
  const fired = tracker.reconcile(waiting, context({ bars: [...context().bars, wick, close], candidate: candidate({ entry: 10.2 }) })).plan;
  assert.equal(fired.status, "triggered");
  assert.equal(fired.entry, 10);
  assert.equal(fired.triggerClose, 10.02);
});

test("fails closed on gap, ambiguous candle, stale quote, and missing candles", () => {
  const armed = tracker.reconcile(null, context()).plan;
  const base = context().bars;
  assert.equal(tracker.reconcile(armed, context({ bars: [...base, bar(1060, 10.02, 10.10, 10, 10.05)] })).plan.status, "missed");
  assert.equal(tracker.reconcile(armed, context({ bars: [...base, bar(1060, 9.92, 10.02, 9.78, 10.01)] })).plan.status, "ambiguous");
  assert.equal(tracker.reconcile(armed, context({ contract: contract({ quote_time: new Date(NOW - 6 * 60_000).toISOString() }) })).plan.status, "cancelled");
  assert.equal(tracker.reconcile(armed, context({ bars: [...base, bar(1300, 9.92, 10.02, 9.9, 10.01)] })).plan.status, "data_gap");
  assert.equal(tracker.reconcile(armed, context({ bars: [...base, bar(1060, 9.92, 10.22, 9.9, 10.01)] })).plan.status, "missed");
});

test("does not arm if the completed 1m history already touched entry", () => {
  const recent = bar(1260, 9.92, 10.03, 9.9, 9.95);
  const result = tracker.reconcile(null, context({ bars: [...context().bars, recent] }));
  assert.equal(result.plan, null);
  assert.match(result.block, /ถูกแตะไปแล้ว/);
});

test("finished setup does not re-arm from the same 5m candle", () => {
  const armed = tracker.reconcile(null, context()).plan;
  const missed = tracker.reconcile(armed, context({ bars: [...context().bars, bar(1060, 10.02, 10.10, 10, 10.05)] })).plan;
  assert.equal(tracker.reconcile(missed, context()).plan.status, "missed");
  const renewed = tracker.reconcile(missed, context({ candidate: candidate({ basedOn: 1200 }) })).plan;
  assert.equal(renewed.status, "armed");
});

test("tracks underlying targets conservatively without calling them option P/L", () => {
  const armed = tracker.reconcile(null, context()).plan;
  const triggerBar = bar(1060, 9.92, 10.05, 9.90, 10.02);
  const triggered = tracker.reconcile(armed, context({ bars: [...context().bars, triggerBar] })).plan;
  const target = bar(1120, 10.02, 10.22, 10, 10.18);
  const tp1 = tracker.reconcile(triggered, context({ bars: [...context().bars, triggerBar, target] })).plan;
  assert.equal(tp1.status, "tp1");
  const both = bar(1180, 10.18, 10.4, 9.79, 10.12);
  assert.equal(tracker.reconcile(tp1, context({ bars: [...context().bars, triggerBar, target, both] })).plan.status, "ambiguous");
});

test("selected option needs a current, valid, reasonably liquid quote", () => {
  assert.equal(tracker.contractCheck(contract(), NOW).ok, true);
  assert.equal(tracker.contractCheck(contract({ bid: .5, ask: 1.5 }), NOW).ok, false);
  assert.equal(tracker.contractCheck(contract({ volume: 0 }), NOW).ok, false);
  assert.equal(tracker.contractCheck(contract({ open_interest: 0 }), NOW).ok, false);
  assert.equal(tracker.contractCheck(contract({ quote_time: new Date(NOW - 6 * 60_000).toISOString() }), NOW).ok, false);
});

test("put setup confirms only on a fresh close below the locked level", () => {
  const put = candidate({ direction: "down", entry: 10, stop: 10.2, tp1: 9.8, tp2: 9.64 });
  const first = bar(1000, 10.1, 10.15, 10.04, 10.08);
  const armed = tracker.reconcile(null, context({ candidate: put, bars: [first] })).plan;
  assert.equal(armed.status, "armed");
  const second = bar(1060, 10.08, 10.1, 9.96, 9.98);
  const triggered = tracker.reconcile(armed, context({ candidate: put, bars: [first, second] })).plan;
  assert.equal(triggered.status, "triggered");
  assert.equal(triggered.direction, "down");
});

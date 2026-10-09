import test from "node:test";
import assert from "node:assert/strict";
import focus from "../focus-list.js";

test("starts with a small independent focus list and normalizes additions", () => {
  assert.deepEqual(focus.cleanSymbols(null), ["QQQ", "NVDA", "GOOGL", "RKLB", "IREN"]);
  assert.deepEqual(focus.cleanSymbols([" nvda ", "NVDA", "googl", "", "bad ticker"]), ["NVDA", "GOOGL"]);
  assert.deepEqual(focus.cleanSymbols([]), []);
  assert.equal(focus.symbol(" rklb "), "RKLB");
  assert.equal(focus.symbol("not valid"), "");
  assert.equal(focus.cleanSymbols(Array.from({ length: 12 }, (_, index) => `T${index}`)).length, focus.MAX_SYMBOLS);
});

test("alerts only on a new, fresh, completed-bar direction transition", () => {
  const waiting = { direction: "wait", fresh: true, asOf: 1000 };
  const call = { direction: "up", fresh: true, asOf: 1060 };
  assert.equal(focus.transition(null, call), null);
  assert.equal(focus.transition(waiting, call), "up");
  assert.equal(focus.transition(call, { ...call, asOf: 1120 }), null);
  assert.equal(focus.transition(call, { direction: "down", fresh: true, asOf: 1120 }), "down");
  assert.equal(focus.transition(waiting, { ...call, fresh: false }), null);
  assert.equal(focus.transition({ ...waiting, fresh: false }, call), null);
  assert.equal(focus.transition(waiting, { ...call, asOf: 1000 }), null);
});

test("focus rows show a quick watch side without implying a trade entry", () => {
  const now = 1_000_000;
  const base = { fresh: true, checkedAt: now, price: 225, direction: "wait" };
  assert.deepEqual(focus.presentation({ ...base, up: 3, down: 1 }, { now }), {
    tone: "up", level: "watch", label: "เฝ้า CALL", detail: "ขึ้น 3/4 · ลง 1/4", current: true
  });
  assert.deepEqual(focus.presentation({ ...base, direction: "down", up: 0, down: 4 }, { now }), {
    tone: "down", level: "full", label: "เฝ้า PUT", detail: "ขึ้น 0/4 · ลง 4/4", current: true
  });
  assert.equal(focus.presentation({ ...base, up: 2, down: 2 }, { now }).label, "WAIT");
});

test("closed, missing, and stale scans do not display a live-looking signal", () => {
  const now = 1_000_000;
  const signal = { fresh: true, checkedAt: now, direction: "up", up: 4, down: 0 };
  assert.equal(focus.presentation(signal, { now, marketOpen: false }).label, "ตลาดปิด");
  assert.equal(focus.presentation({ ...signal, missing: true }, { now }).label, "รอข้อมูล");
  assert.equal(focus.presentation({ ...signal, checkedAt: now - focus.STATUS_MAX_AGE_MS - 1 }, { now }).label, "ข้อมูลเก่า");
  assert.equal(focus.presentation(signal, { now: now + focus.STATUS_MAX_AGE_MS }).current, true);
});

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

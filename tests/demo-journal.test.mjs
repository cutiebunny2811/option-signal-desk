import test from "node:test";
import assert from "node:assert/strict";
import journal from "../demo-journal.js";

const trade = (overrides = {}) => ({
  contract_label: "QQQ 718 PUT", underlying_symbol: "QQQ", option_side: "put", contracts: 1,
  buy_total: 105.64, sell_total: 149.35, fees_total: 1.2,
  opened_at: "2026-10-21T11:00", closed_at: "2026-10-21T12:06",
  followed_signal: true, notes: "", ...overrides
});

test("closed Demo trade uses total paid and received, net of entered fees", () => {
  const row = journal.validate(trade());
  assert.equal(row.opened_at, "2026-10-21T04:00:00.000Z");
  assert.equal(row.closed_at, "2026-10-21T05:06:00.000Z");
  assert.deepEqual(journal.result(row), { net: 42.51, heldMs: 66 * 60_000 });
  assert.equal(journal.duration(66 * 60_000), "1 ชม. 6 น.");
});

test("followed filter and win rate exclude manual and breakeven trades", () => {
  const rows = [
    journal.validate(trade()),
    journal.validate(trade({ buy_total: 100, sell_total: 80, fees_total: 0 })),
    journal.validate(trade({ buy_total: 50, sell_total: 50, fees_total: 0 })),
    journal.validate(trade({ buy_total: 10, sell_total: 300, followed_signal: false })),
    { ...journal.validate(trade({ buy_total: 10, sell_total: 300 })), voided_at: "2026-10-21T07:00:00Z" }
  ];
  assert.deepEqual({ ...journal.summarize(rows), averageHoldMs: null }, {
    count: 3, wins: 1, losses: 1, breakeven: 1, net: 22.51, winRate: 50, averageHoldMs: null
  });
  assert.equal(journal.summarize(rows, false).count, 4);
  assert.equal(journal.summarize(rows, false).wins, 2);
});

test("entry validation rejects missing totals, invalid time order and invalid ticker", () => {
  assert.throws(() => journal.validate(trade({ buy_total: "" })), /ยอดซื้อ/);
  assert.throws(() => journal.validate(trade({ sell_total: "" })), /ยอดซื้อ/);
  assert.throws(() => journal.validate(trade({ closed_at: "2026-10-21T10:00" })), /เวลาปิด/);
  assert.throws(() => journal.validate(trade({ underlying_symbol: "QQ Q" })), /ticker/);
});

test("CSV escapes notes and exports calculated net only for active rows", () => {
  const rows = [journal.validate(trade({ notes: 'plan "A", wait' })), { ...journal.validate(trade()), voided_at: "2026-10-21T07:00:00Z" }];
  const output = journal.csv(rows);
  assert.ok(output.startsWith("\uFEFF"));
  assert.match(output, /"42.51"/);
  assert.match(output, /"plan ""A"", wait"/);
  assert.equal(output.split("\r\n").length, 2);
});

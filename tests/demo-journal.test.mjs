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

test("history pages all 100+ trades without truncating statistics or CSV", () => {
  const rows = Array.from({ length: 103 }, (_, index) => ({
    ...journal.validate(trade({ contract_label: `${index % 2 ? "NVDA" : "QQQ"} ${700 + index} CALL`, underlying_symbol: index % 2 ? "NVDA" : "QQQ" })),
    id: `row-${index}`, closed_at: new Date(Date.UTC(2026, 9, 21, 12, index)).toISOString()
  }));
  const first = journal.pageRows(rows, { pageSize: 10 });
  assert.equal(first.total, 103);
  assert.equal(first.pages, 11);
  assert.equal(first.rows.length, 10);
  assert.equal(first.rows[0].id, "row-102");
  const last = journal.pageRows(rows, { page: 50, pageSize: 10 });
  assert.equal(last.page, 10);
  assert.equal(last.rows.length, 3);
  assert.equal(last.rows.at(-1).id, "row-0");
  assert.equal(journal.summarize(rows).count, 103);
  assert.equal(journal.csv(rows).split("\r\n").length, 104);
});

test("history search and followed filter apply before pagination", () => {
  const rows = [
    { ...journal.validate(trade({ contract_label: "QQQ 724 CALL" })), id: "qqq" },
    { ...journal.validate(trade({ contract_label: "NVDA 220 PUT", underlying_symbol: "NVDA", followed_signal: false })), id: "nvda" },
    { ...journal.validate(trade({ contract_label: "QQQ 725 CALL" })), id: "void", voided_at: "2026-10-21T15:00:00Z" }
  ];
  assert.equal(journal.pageRows(rows, { query: "nvda" }).total, 0);
  assert.equal(journal.pageRows(rows, { followedOnly: false, query: "nvda" }).rows[0].id, "nvda");
  assert.equal(journal.pageRows(rows, { query: "724" }).rows[0].id, "qqq");
});

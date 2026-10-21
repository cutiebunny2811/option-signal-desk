import test from "node:test";
import assert from "node:assert/strict";
import images from "../demo-image-import.js";
import journal from "../demo-journal.js";

const screenshotText = (action, price, filledTime, placedTime, options = {}) => `
03:45
PM
ABC US$100
28 Oct 26 (W) Call 100
คำสั่ง ${action}
จำนวนทั้งหมด 2
จำนวนที่จับคู่แล้ว ${options.filled ?? 2}
ราคาเฉลี่ย US$${price}
คำสั่งถูกจับคู่สำเร็จ ${filledTime}
ราคาลิมิต US$99.99
วันและเวลาที่ส่งคำสั่ง ${placedTime}
ราคาตรงกลาง (Mid Price) 12.00
`;

test("Filled buy/sell screenshots create one closed trade from average fill, not limit/mid", () => {
  const buy = images.parseFilledImageText(screenshotText("ซื้อ", "8.60", "10/21/2026 11:03:24 EDT", "10/21/2026 11:02:35 EDT"), "buy");
  const sell = images.parseFilledImageText(screenshotText("ขาย", "9.67", "10/21/2026 12:11:33 EDT", "10/21/2026 12:08:43 EDT"), "sell");
  const trade = images.buildClosedTrade(buy, sell);
  assert.equal(trade.contract_label, "ABC 100 CALL · 2026-10-28");
  assert.equal(trade.buy_total, 1720);
  assert.equal(trade.sell_total, 1934);
  assert.equal(trade.opened_at, "2026-10-21T22:03:24");
  assert.equal(trade.closed_at, "2026-10-21T23:11:33");
  assert.equal(trade.followed_signal, false);
  assert.deepEqual(journal.result(journal.validate(trade)), { net: 214, heldMs: 4089000 });
});

test("import blocks swapped sides, partially filled orders and missing Filled time", () => {
  const buyText = screenshotText("ซื้อ", "8.60", "10/21/2026 11:03:24 EDT", "10/21/2026 11:02:35 EDT");
  assert.throws(() => images.parseFilledImageText(buyText, "sell"), /สลับรูป/);
  assert.throws(() => images.parseFilledImageText(screenshotText("ซื้อ", "8.60", "10/21/2026 11:03:24 EDT", "10/21/2026 11:02:35 EDT", { filled: 1 }), "buy"), /จับคู่ไม่ครบ/);
  assert.throws(() => images.parseFilledImageText(buyText.replace("คำสั่งถูกจับคู่สำเร็จ ", ""), "buy"), /เวลา Filled/);
});

test("pairing rejects different strikes and unequal contract quantities", () => {
  const buy = images.parseFilledImageText(screenshotText("ซื้อ", "8.60", "10/21/2026 11:03:24 EDT", "10/21/2026 11:02:35 EDT"), "buy");
  const sell = images.parseFilledImageText(screenshotText("ขาย", "9.67", "10/21/2026 12:11:33 EDT", "10/21/2026 12:08:43 EDT"), "sell");
  assert.throws(() => images.buildClosedTrade(buy, { ...sell, strike: 101 }), /Strike/);
  assert.throws(() => images.buildClosedTrade(buy, { ...sell, contracts: 1 }), /จำนวนซื้อ/);
  assert.throws(() => images.buildClosedTrade(buy, { ...sell, filledAt: "2026-10-21T10:00:00Z" }), /เวลาขาย/);
});

(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskSignalPolicy = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  function current(trend) {
    return Boolean(trend?.usable && !trend.stale && !trend.closed);
  }

  function assess(trends, marketOpen = true) {
    const minute = trends?.M1, five = trends?.M5, fifteen = trends?.M15;
    const fresh = Boolean(marketOpen && current(minute) && current(five));
    const short = [minute, five, fifteen];
    const up = short.filter((trend) => current(trend) && trend.direction === "up").length;
    const down = short.filter((trend) => current(trend) && trend.direction === "down").length;
    const base = { direction: "wait", tier: "wait", fresh, up, down };
    if (!fresh || minute.direction === "wait" || minute.direction !== five.direction) return base;
    const direction = minute.direction;
    if (current(fifteen) && fifteen.direction !== "wait" && fifteen.direction !== direction) {
      return { ...base, opposed: true };
    }
    const tier = current(fifteen) && fifteen.direction === direction ? "aligned" : "early";
    return { direction, tier, fresh, up, down };
  }

  function priceActionContext(bars) {
    const recent = Array.isArray(bars) ? bars.slice(-4) : [];
    if (recent.length < 4 || recent.some((bar) => !Number.isFinite(bar?.open) || !Number.isFinite(bar?.close))) {
      return { direction: "wait", label: "ข้อมูลไม่พอ", detail: "ต้องมี 1h ย้อนหลังอย่างน้อย 4 แท่ง" };
    }
    const bullish = recent.filter((bar) => bar.close > bar.open).length;
    const bearish = recent.filter((bar) => bar.close < bar.open).length;
    const change = recent.at(-1).close - recent[0].close;
    const direction = change > 0 && bullish >= 3 ? "up" : change < 0 && bearish >= 3 ? "down" : "wait";
    return {
      direction,
      label: direction === "up" ? "ขึ้นเดิม" : direction === "down" ? "ลงเดิม" : "แกว่ง",
      detail: "อ่านแท่ง 1h ย้อนหลัง 4 แท่ง · ไม่ใช่สัญญาณสด"
    };
  }

  return { assess, priceActionContext };
});

(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskFocus = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  const DEFAULT_SYMBOLS = Object.freeze(["QQQ", "NVDA", "GOOGL", "RKLB", "IREN"]);
  const MAX_SYMBOLS = 10;
  const STATUS_MAX_AGE_MS = 8 * 60_000;
  const VALID_SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;

  function symbol(value) {
    const normalized = String(value || "").trim().toUpperCase();
    return VALID_SYMBOL.test(normalized) ? normalized : "";
  }

  function cleanSymbols(values) {
    if (!Array.isArray(values)) return [...DEFAULT_SYMBOLS];
    return [...new Set(values.map(symbol).filter(Boolean))].slice(0, MAX_SYMBOLS);
  }

  function transition(previous, next) {
    if (!previous?.fresh || !next?.fresh || !["up", "down"].includes(next.direction)) return null;
    if (!Number.isFinite(previous.asOf) || !Number.isFinite(next.asOf) || next.asOf <= previous.asOf) return null;
    return previous.direction !== next.direction ? next.direction : null;
  }

  function presentation(summary, { marketOpen = true, now = Date.now() } = {}) {
    if (!marketOpen) return { tone: "wait", level: "idle", label: "ตลาดปิด", detail: "รอสัญญาณรอบถัดไป", current: false };
    if (summary?.missing) return { tone: "wait", level: "idle", label: "รอข้อมูล", detail: "ตรวจข้อมูลหุ้นใน PCC", current: false };
    if (summary?.error) return { tone: "wait", level: "idle", label: "สแกนไม่สำเร็จ", detail: "กดเปิดหุ้นเพื่อตรวจข้อมูล", current: false };
    const current = summary?.fresh && Number.isFinite(summary.checkedAt)
      && now >= summary.checkedAt && now - summary.checkedAt <= STATUS_MAX_AGE_MS;
    if (!current) return { tone: "wait", level: "idle", label: summary ? "ข้อมูลเก่า" : "รอสแกน", detail: "ยังไม่มีสัญญาณสด", current: false };
    const tone = ["up", "down"].includes(summary.direction) ? summary.direction : "wait";
    const tier = summary.tier === "aligned" ? "aligned" : "early";
    return {
      tone,
      level: tone === "wait" ? "idle" : tier === "aligned" ? "full" : "watch",
      label: tone === "up" ? "เฝ้า CALL" : tone === "down" ? "เฝ้า PUT" : "WAIT",
      detail: tone === "wait" ? "แท่งสั้นยังไม่ตรง" : tier === "aligned" ? "3/3 แท่งปิดตรงกัน" : "เร็ว 2/3 · 15m ยังไม่ยืนยัน",
      current: true
    };
  }

  return { DEFAULT_SYMBOLS, MAX_SYMBOLS, STATUS_MAX_AGE_MS, symbol, cleanSymbols, transition, presentation };
});

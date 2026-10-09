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
    const up = Math.max(0, Math.min(4, Number(summary.up) || 0));
    const down = Math.max(0, Math.min(4, Number(summary.down) || 0));
    const tone = up >= 3 && up > down ? "up" : down >= 3 && down > up ? "down" : "wait";
    return {
      tone,
      level: tone === "wait" ? "idle" : Math.max(up, down) === 4 ? "full" : "watch",
      label: tone === "up" ? "เฝ้า CALL" : tone === "down" ? "เฝ้า PUT" : "WAIT",
      detail: `ขึ้น ${up}/4 · ลง ${down}/4`,
      current: true
    };
  }

  return { DEFAULT_SYMBOLS, MAX_SYMBOLS, STATUS_MAX_AGE_MS, symbol, cleanSymbols, transition, presentation };
});

(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskFocus = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  const DEFAULT_SYMBOLS = Object.freeze(["QQQ", "NVDA", "GOOGL", "RKLB", "IREN"]);
  const MAX_SYMBOLS = 10;
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

  return { DEFAULT_SYMBOLS, MAX_SYMBOLS, symbol, cleanSymbols, transition };
});

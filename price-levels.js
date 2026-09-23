(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskLevels = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  function ema(values, period) {
    if (!values.length) return [];
    const multiplier = 2 / (period + 1);
    const result = [values[0]];
    for (let index = 1; index < values.length; index += 1) {
      result.push(values[index] * multiplier + result[index - 1] * (1 - multiplier));
    }
    return result;
  }

  function atr(bars, period = 14) {
    if (bars.length <= period) return null;
    const ranges = [];
    for (let index = 1; index < bars.length; index += 1) {
      const current = bars[index], previous = bars[index - 1];
      ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
    }
    let value = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
    for (let index = period; index < ranges.length; index += 1) value = (value * (period - 1) + ranges[index]) / period;
    return value;
  }

  const upCent = (value) => Math.ceil((value - 1e-9) * 100) / 100;
  const downCent = (value) => Math.floor((value + 1e-9) * 100) / 100;
  const roundCent = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

  function describe(bars) {
    if (!Array.isArray(bars) || bars.length < 30) return null;
    if (!bars.every((bar) => [bar.high, bar.low, bar.close].every(Number.isFinite) && bar.high >= bar.low && bar.close > 0)) return null;
    const closes = bars.map((bar) => bar.close);
    const ema9 = ema(closes, 9), ema21 = ema(closes, 21);
    const volatility = atr(bars, 14);
    if (!Number.isFinite(volatility) || volatility <= 0) return null;
    return {
      ema9: roundCent(ema9.at(-1)), ema21: roundCent(ema21.at(-1)),
      atr14: roundCent(volatility), projection: roundCent(ema9.at(-1) + (ema9.at(-1) - ema9.at(-4))),
      basedOn: bars.at(-1).time, timeframe: "5m", projectionHorizonMinutes: 15
    };
  }

  function calculate(bars, direction) {
    if (!["up", "down"].includes(direction)) return null;
    const indicators = describe(bars);
    if (!indicators) return null;
    const volatility = atr(bars, 14);

    const lastTen = bars.slice(-10), lastFive = bars.slice(-5);
    const highTen = Math.max(...lastTen.map((bar) => bar.high));
    const lowTen = Math.min(...lastTen.map((bar) => bar.low));
    const highFive = Math.max(...lastFive.map((bar) => bar.high));
    const lowFive = Math.min(...lastFive.map((bar) => bar.low));
    const buffer = .1 * volatility;
    const entry = direction === "up" ? upCent(highTen + buffer) : downCent(lowTen - buffer);
    const stop = direction === "up"
      ? downCent(Math.min(lowFive - buffer, entry - .8 * volatility))
      : upCent(Math.max(highFive + buffer, entry + .8 * volatility));
    const risk = roundCent(Math.abs(entry - stop));
    if (risk <= 0 || risk > 8 * volatility || stop <= 0) return null;
    const sign = direction === "up" ? 1 : -1;
    const tp1 = roundCent(entry + sign * risk);
    const tp2 = roundCent(entry + sign * risk * 1.8);
    if (Math.min(tp1, tp2) <= 0) return null;
    return {
      direction, entry, stop, tp1, tp2, risk, wideRisk: risk > 3 * volatility,
      ...indicators,
      breakoutBars: 10, swingBars: 5, bufferAtr: .1, minimumRiskAtr: .8,
      rr1: 1, rr2: 1.8
    };
  }

  return { ema, atr, describe, calculate };
});

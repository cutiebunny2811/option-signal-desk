(() => {
  "use strict";

  const config = window.__OPTION_DESK_CONFIG__;
  const demo = ["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).get("preview") === "1";
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const numeric = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const money = (value, decimals = 2) => numeric(value) === null ? "—" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  const strikeMoney = (value) => numeric(value) === null ? "—" : `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const count = (value) => numeric(value) === null ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const signedPercent = (value) => numeric(value) === null ? "" : `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
  const bkkTime = (value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " น." : "ไม่ทราบเวลา";
  };
  const state = {
    db: null, user: null, watchlist: [], pulse: [], search: "", symbol: "", instrumentId: null,
    call: null, put: null, expiry: "", side: "call", contractSymbol: "", charts: {}, chartFrame: "M60",
    chart: null, resizeObserver: null, busy: false, requestId: 0, lastError: ""
  };

  function setStatus(message = "", isError = false) {
    const line = $("#status-line");
    line.textContent = message;
    line.classList.toggle("error", isError);
  }

  function ema(values, period) {
    if (!values.length) return [];
    const multiplier = 2 / (period + 1);
    const result = [values[0]];
    for (let index = 1; index < values.length; index += 1) result.push(values[index] * multiplier + result[index - 1] * (1 - multiplier));
    return result;
  }

  function normalizeBars(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Map();
    for (const bar of input) {
      const time = Date.parse(bar?.time);
      const open = numeric(bar?.open), high = numeric(bar?.high), low = numeric(bar?.low), close = numeric(bar?.close);
      if (![time, open, high, low, close].every(Number.isFinite) || close <= 0 || high < low) continue;
      seen.set(Math.floor(time / 1000), { time: Math.floor(time / 1000), open, high, low, close, volume: numeric(bar?.volume) || 0 });
    }
    return [...seen.values()].sort((a, b) => a.time - b.time);
  }

  function trendFor(frame) {
    const bars = normalizeBars(state.charts[frame]?.bars);
    if (bars.length < 25) return { direction: "wait", label: "รอข้อมูล", detail: "แท่งราคาไม่พอ" };
    const closes = bars.map((bar) => bar.close);
    const fast = ema(closes, 9).at(-1), slow = ema(closes, 21).at(-1), last = closes.at(-1);
    if (last > fast && fast > slow) return { direction: "up", label: "ขึ้น", detail: `ราคา > EMA9 > EMA21` };
    if (last < fast && fast < slow) return { direction: "down", label: "ลง", detail: `ราคา < EMA9 < EMA21` };
    return { direction: "wait", label: "รอ", detail: "EMA ยังไม่เรียงตัว" };
  }

  function renderWatchlist() {
    const rows = state.watchlist.filter((item) => item.symbol.includes(state.search));
    const prices = new Map(state.pulse.map((row) => [String(row.symbol).toUpperCase(), row]));
    $("#watch-list").innerHTML = rows.length ? rows.map((item) => {
      const quote = prices.get(item.symbol);
      return `<button class="watch-item ${item.symbol === state.symbol ? "active" : ""}" type="button" data-symbol="${esc(item.symbol)}" aria-pressed="${item.symbol === state.symbol}"><strong>${esc(item.symbol)}</strong><span class="watch-price">${money(quote?.price)}</span><small>${esc(item.name || "หุ้นใน PCC")}</small></button>`;
    }).join("") : `<p class="empty-list">${state.search ? "ไม่พบ ticker ที่ค้นหา" : "ยังไม่มีหุ้นใน watchlist"}</p>`;
  }

  function renderHeader() {
    const underlying = state.call?.underlying || state.put?.underlying || null;
    const price = underlying?.price;
    const change = underlying?.change_percent;
    $("#symbol-title").textContent = state.symbol || "—";
    $("#spot-price").textContent = money(price);
    $("#spot-change").textContent = signedPercent(change);
    $("#spot-change").className = `ticker-change ${numeric(change) === null ? "" : Number(change) >= 0 ? "positive" : "negative"}`;
    $("#spot-time").textContent = underlying ? `ราคาหุ้น ณ ${bkkTime(underlying.market_time)} · ข้อมูล option ณ ${bkkTime(state.call?.fetched_at || state.put?.fetched_at)}` : state.busy ? "กำลังโหลดข้อมูล" : "เลือกหุ้นเพื่อดูข้อมูล";
    $("#symbol-input").value = state.symbol;
    $("#refresh-button").disabled = state.busy || !state.symbol;
    const badge = $("#source-pill");
    badge.textContent = demo ? "DEMO / ข้อมูลตัวอย่าง" : state.call || state.put ? "WEBULL OPRA" : "รอข้อมูล";
    badge.className = `source-pill ${demo ? "demo" : state.call || state.put ? "live" : ""}`;
    $("#market-status").textContent = demo ? "โหมดตัวอย่าง" : state.busy ? "กำลังอ่านข้อมูล" : state.call || state.put ? "เชื่อม PCC แล้ว" : "รอข้อมูล";
    $("#market-status").classList.toggle("is-demo", demo);
  }

  function renderSignals() {
    const frames = [["M60", "1H"], ["M240", "4H"], ["D", "1D"]];
    const trends = frames.map(([frame, label]) => ({ ...trendFor(frame), frame, frameLabel: label }));
    $("#signal-grid").innerHTML = trends.map((trend) => `<div class="signal-card"><small>${trend.frameLabel}</small><strong class="${trend.direction}">${trend.label}</strong><span>${esc(trend.detail)}</span></div>`).join("");
    const up = trends.filter((trend) => trend.direction === "up").length;
    const down = trends.filter((trend) => trend.direction === "down").length;
    const available = up + down;
    const loaded = frames.filter(([frame]) => normalizeBars(state.charts[frame]?.bars).length >= 25).length;
    const verdict = $("#signal-verdict");
    let message = "รอข้อมูลกราฟ", detail = "ยังประเมินแนวโน้มไม่ได้", tone = "wait";
    if (available === 3 && up === 3) { message = "แนวโน้มขึ้นตรงกัน 3/3"; detail = "ตรวจสัญญา CALL และเงื่อนไขเข้าเพิ่มเติม"; tone = "up"; }
    else if (available === 3 && down === 3) { message = "แนวโน้มลงตรงกัน 3/3"; detail = "ตรวจสัญญา PUT และเงื่อนไขเข้าเพิ่มเติม"; tone = "down"; }
    else if (loaded > 0) { message = "ทิศทางยังไม่ตรงกัน"; detail = `${up} ขึ้น · ${down} ลง · ${3 - available} รอ`; }
    verdict.className = `signal-verdict ${tone}`;
    verdict.innerHTML = `<span>${message}</span><small>${detail}</small>`;
  }

  function clearChart() {
    state.resizeObserver?.disconnect();
    state.resizeObserver = null;
    state.chart?.remove();
    state.chart = null;
  }

  function renderChart() {
    const container = $("#price-chart");
    clearChart();
    container.replaceChildren();
    const data = state.charts[state.chartFrame];
    const bars = normalizeBars(data?.bars);
    $("#chart-freshness").textContent = data?.fetched_at ? `${data.stale ? "แคชเก่า" : data.cached ? "จากแคช" : "อัปเดต"} · ${bkkTime(data.fetched_at)}` : "ยังไม่มีข้อมูล";
    for (const button of $("#chart-frames").querySelectorAll("button")) button.classList.toggle("active", button.dataset.frame === state.chartFrame);
    if (!bars.length) { container.innerHTML = `<div class="chart-empty">${state.busy ? "กำลังเปิดกราฟ…" : "ยังไม่มีกราฟสำหรับหุ้นนี้"}</div>`; return; }
    const library = window.LightweightCharts;
    if (!library?.createChart) { container.innerHTML = `<div class="chart-empty">กราฟโหลดไม่สำเร็จ กรุณารีเฟรชหน้า</div>`; return; }
    const chart = library.createChart(container, {
      width: container.clientWidth, height: container.clientHeight, layout: { background: { color: "#0d1013" }, textColor: "#9fa39d", fontFamily: "IBM Plex Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: "#20252a" }, horzLines: { color: "#20252a" } },
      rightPriceScale: { borderColor: "#35383e" }, timeScale: { borderColor: "#35383e", timeVisible: state.chartFrame !== "D" },
      crosshair: { vertLine: { color: "#d4af3777" }, horzLine: { color: "#d4af3777" } },
      handleScroll: { horzTouchDrag: true, vertTouchDrag: false }
    });
    const candles = chart.addSeries(library.CandlestickSeries, { upColor: "#68c299", downColor: "#e4545e", borderVisible: false, wickUpColor: "#68c299", wickDownColor: "#e4545e" });
    candles.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    const volume = chart.addSeries(library.HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
    volume.setData(bars.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "#68c29966" : "#e4545e66" })));
    chart.priceScale("volume").applyOptions({ visible: false, scaleMargins: { top: .83, bottom: 0 } });
    const closes = bars.map((bar) => bar.close);
    [[9, "#d4af37"], [21, "#ded9cc"]].forEach(([period, color]) => {
      const line = chart.addSeries(library.LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const values = ema(closes, period);
      line.setData(bars.map((bar, index) => ({ time: bar.time, value: values[index] })));
    });
    chart.timeScale().fitContent();
    state.chart = chart;
    state.resizeObserver = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }));
    state.resizeObserver.observe(container);
  }

  function chain(side) { return side === "put" ? state.put : state.call; }
  function contracts(side) { return Array.isArray(chain(side)?.contracts) ? chain(side).contracts : []; }
  function mergedOiRows() {
    const rows = new Map();
    for (const side of ["call", "put"]) for (const contract of contracts(side)) {
      const strike = numeric(contract.strike);
      if (strike === null) continue;
      if (!rows.has(strike)) rows.set(strike, { strike, call: null, put: null });
      rows.get(strike)[side] = contract;
    }
    return [...rows.values()].sort((a, b) => a.strike - b.strike);
  }

  function renderExpiry() {
    const expiries = state.call?.expiries || state.put?.expiries || [];
    const select = $("#expiry-select");
    select.disabled = !expiries.length || state.busy;
    select.innerHTML = expiries.length ? expiries.map((item) => `<option value="${esc(item.value)}">${esc(item.value)} · ${count(item.dte)} DTE</option>`).join("") : `<option>รอข้อมูล</option>`;
    if (state.expiry) select.value = state.expiry;
  }

  function renderOi() {
    renderExpiry();
    const rows = mergedOiRows();
    const spot = numeric(state.call?.underlying?.price ?? state.put?.underlying?.price);
    const callTotal = rows.reduce((sum, row) => sum + (numeric(row.call?.open_interest) || 0), 0);
    const putTotal = rows.reduce((sum, row) => sum + (numeric(row.put?.open_interest) || 0), 0);
    const largestCall = rows.reduce((best, row) => (numeric(row.call?.open_interest) || 0) > (numeric(best?.call?.open_interest) || 0) ? row : best, null);
    const largestPut = rows.reduce((best, row) => (numeric(row.put?.open_interest) || 0) > (numeric(best?.put?.open_interest) || 0) ? row : best, null);
    $("#oi-summary").innerHTML = `<div><small>CALL OI รวม*</small><strong class="call">${count(callTotal)}</strong></div><div><small>PUT OI รวม*</small><strong class="put">${count(putTotal)}</strong></div><div><small>PUT / CALL OI*</small><strong>${callTotal ? (putTotal / callTotal).toFixed(2) : "—"}</strong></div>`;
    if (!rows.length) { $("#oi-rows").innerHTML = `<tr><td colspan="7" class="empty-panel">${state.busy ? "กำลังอ่าน option chain…" : "ยังไม่มีข้อมูล OI สำหรับหุ้นนี้"}</td></tr>`; return; }
    const maxOi = Math.max(...rows.flatMap((row) => [numeric(row.call?.open_interest) || 0, numeric(row.put?.open_interest) || 0]), 1);
    const nearest = spot === null ? null : rows.reduce((best, row) => Math.abs(row.strike - spot) < Math.abs((best?.strike ?? Infinity) - spot) ? row : best, null)?.strike;
    $("#oi-rows").innerHTML = rows.map((row) => {
      const callOi = numeric(row.call?.open_interest) || 0, putOi = numeric(row.put?.open_interest) || 0;
      return `<tr class="${row.strike === nearest ? "near" : ""}"><td class="oi-val"><button class="oi-pick" type="button" data-pick-side="call" data-pick-strike="${row.strike}" ${row.call ? "" : "disabled"}>${count(row.call?.open_interest)}</button></td><td class="bar-cell" colspan="2"><span class="oi-bar" style="width:${Math.max(callOi / maxOi * 100, callOi ? 2 : 0)}%"></span></td><td class="strike">${strikeMoney(row.strike)}</td><td class="bar-cell" colspan="2"><span class="oi-bar put" style="width:${Math.max(putOi / maxOi * 100, putOi ? 2 : 0)}%"></span></td><td class="oi-val"><button class="oi-pick" type="button" data-pick-side="put" data-pick-strike="${row.strike}" ${row.put ? "" : "disabled"}>${count(row.put?.open_interest)}</button></td></tr>`;
    }).join("");
    // These levels describe where OI is concentrated; they are not support/resistance predictions.
    state.oiLeaders = { call: largestCall?.strike ?? null, put: largestPut?.strike ?? null };
  }

  function renderContract() {
    for (const button of $("#option-side").querySelectorAll("button")) button.classList.toggle("active", button.dataset.side === state.side);
    const rows = [...contracts(state.side)].sort((a, b) => Math.abs(Number(a.strike) - Number(chain(state.side)?.underlying?.price)) - Math.abs(Number(b.strike) - Number(chain(state.side)?.underlying?.price)));
    if (!rows.some((row) => row.symbol === state.contractSymbol)) state.contractSymbol = rows[0]?.symbol || "";
    $("#contract-list").innerHTML = rows.length ? rows.map((row) => `<button class="contract-row ${row.symbol === state.contractSymbol ? "active" : ""}" type="button" data-contract="${esc(row.symbol)}"><strong>${strikeMoney(row.strike)} ${state.side.toUpperCase()}</strong><span class="contract-ask">ASK ${money(row.ask)}</span><small>Δ ${numeric(row.delta)?.toFixed(2) ?? "—"} · OI ${count(row.open_interest)} · VOL ${count(row.volume)}</small></button>`).join("") : `<div class="empty-panel">${state.busy ? "กำลังอ่านสัญญา…" : "ไม่มีข้อมูลสัญญาฝั่งนี้"}</div>`;
    const selected = rows.find((row) => row.symbol === state.contractSymbol);
    if (!selected) { $("#contract-detail").innerHTML = `<div class="empty-panel">เลือกสัญญาเพื่อดูรายละเอียด</div>`; $("#decision-note").innerHTML = ""; return; }
    const ask = numeric(selected.ask), bid = numeric(selected.bid), mid = ask !== null && bid !== null ? (ask + bid) / 2 : null;
    const spread = mid && ask !== null && bid !== null ? (ask - bid) / mid * 100 : null;
    const strike = numeric(selected.strike);
    const multiplier = numeric(selected.multiplier) || 100;
    const breakEven = ask !== null && strike !== null ? state.side === "call" ? strike + ask : strike - ask : null;
    const cost = ask === null ? null : ask * multiplier;
    const iv = numeric(selected.implied_volatility);
    $("#contract-detail").innerHTML = `<h3>${strikeMoney(strike)} ${state.side.toUpperCase()}</h3><span class="contract-code">${esc(selected.symbol)}</span><div class="contract-stat-lead"><div><small>BID / ASK</small><strong>${money(bid)} / ${money(ask)}</strong></div><div><small>SPREAD</small><strong>${spread === null ? "—" : spread.toFixed(1) + "%"}</strong></div></div><dl class="detail-grid"><div><dt>Delta</dt><dd>${numeric(selected.delta)?.toFixed(3) ?? "—"}</dd></div><div><dt>IV</dt><dd>${iv === null ? "—" : (iv * 100).toFixed(1) + "%"}</dd></div><div><dt>Volume / OI</dt><dd>${count(selected.volume)} / ${count(selected.open_interest)}</dd></div><div><dt>Theta / วัน</dt><dd>${numeric(selected.theta)?.toFixed(3) ?? "—"}</dd></div><div><dt>ต้นทุนที่ Ask</dt><dd>${money(cost, 0)}</dd></div><div><dt>คุ้มทุน ณ หมดอายุ</dt><dd>${money(breakEven)}</dd></div></dl>`;
    const warnings = [];
    if (spread === null) warnings.push("ไม่มี bid/ask ครบ จึงประเมิน spread ไม่ได้");
    else if (spread > 10) warnings.push(`spread ${spread.toFixed(1)}% ค่อนข้างกว้าง`);
    if ((numeric(selected.volume) || 0) < 10) warnings.push("volume วันนี้ต่ำ");
    if ((numeric(selected.open_interest) || 0) < 100) warnings.push("OI ต่ำกว่า 100 สัญญา");
    $("#decision-note").innerHTML = `<strong>เช็กก่อนเลือกสัญญา</strong><p>${warnings.length ? warnings.map(esc).join(" · ") : "bid/ask และสภาพคล่องเบื้องต้นอยู่ในช่วงที่อ่านค่าได้"}</p><p>ต้นทุนคำนวณจากราคา Ask × ${multiplier} · ยังไม่มีจุดเข้า / TP / SL ที่ผ่านการทดสอบ</p><small>Quote ณ ${bkkTime(selected.quote_time || chain(state.side)?.fetched_at)}</small>`;
  }

  function renderAll() { renderWatchlist(); renderHeader(); renderSignals(); renderChart(); renderOi(); renderContract(); }

  async function edge(action, body) {
    const { data, error } = await state.db.functions.invoke("refresh-stock-prices", { body: { action, ...body } });
    if (error) {
      let detail = error.message;
      try { detail = (await error.context?.clone?.().json())?.error || detail; } catch (_) { /* Keep SDK message. */ }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(String(data.error));
    return data;
  }

  function demoBars(seed, frame) {
    const step = frame === "D" ? 86400 : frame === "M240" ? 14400 : 3600;
    const base = Math.floor(Date.now() / 1000 / step) * step - 180 * step;
    let last = seed;
    return Array.from({ length: 180 }, (_, index) => {
      const move = Math.sin(index / 7) * .0038 + Math.cos(index / 15) * .0024 + (index > 155 ? .005 : .00028);
      const open = last, close = open * (1 + move);
      last = close;
      return { time: new Date((base + index * step) * 1000).toISOString(), open, high: Math.max(open, close) * 1.003, low: Math.min(open, close) * .997, close, volume: 800000 + (index * 71431) % 1100000 };
    });
  }

  function demoChain(symbol, side, expiry) {
    const prices = { SKHY: 161.98, CRWV: 81.77, NVDA: 174.42, AMD: 224.15, MU: 138.72, TSLA: 268.05 };
    const price = prices[symbol] || 161.98;
    const chosenExpiry = expiry || "2026-10-16";
    const center = Math.round(price / 5) * 5;
    const contracts = Array.from({ length: 15 }, (_, index) => {
      const strike = center + (index - 7) * 5;
      const distance = Math.abs(strike - price);
      const intrinsic = side === "call" ? Math.max(price - strike, 0) : Math.max(strike - price, 0);
      const mid = intrinsic + .3 + 5.5 * Math.exp(-distance / 22);
      const oi = Math.round((1800 + ((index * 4871 + (side === "put" ? 377 : 0)) % 8500)) * (index % 4 === 0 ? 1.5 : 1));
      return { symbol: `${symbol}${chosenExpiry.replaceAll("-", "").slice(2)}${side === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`, expiry: chosenExpiry, option_type: side, strike, multiplier: 100, bid: +(mid - .10).toFixed(2), ask: +(mid + .10).toFixed(2), mid, delta: +(side === "call" ? Math.min(.95, Math.max(.05, .53 - (strike - price) * .015)) : Math.max(-.95, Math.min(-.05, -.45 - (strike - price) * .015))).toFixed(3), theta: -.12, implied_volatility: .43 + index * .006, volume: 35 + (index * 171) % 850, open_interest: oi, quote_time: new Date().toISOString() };
    });
    return { source: "demo", symbol, option_type: side, expiry: chosenExpiry, expiries: [{ value: "2026-10-16", dte: 23 }, { value: "2026-11-20", dte: 58 }], underlying: { price, change_percent: symbol === "CRWV" ? 1.05 : 1.34, market_time: new Date().toISOString() }, contracts, fetched_at: new Date().toISOString() };
  }

  async function getOptionChain(symbol, side, expiry) { return demo ? demoChain(symbol, side, expiry) : edge("option_chain", { symbol, option_type: side, expiry: expiry || null }); }
  async function getChart(instrumentId, frame, symbol) {
    if (demo) {
      const price = demoChain(symbol, "call").underlying.price;
      const bars = demoBars(price, frame);
      const scale = price / bars.at(-1).close;
      return { bars: bars.map((bar) => ({ ...bar, open: bar.open * scale, high: bar.high * scale, low: bar.low * scale, close: bar.close * scale })), fetched_at: new Date().toISOString(), cached: false };
    }
    if (!instrumentId) return null;
    return edge("chart", { instrument_id: instrumentId, timespan: frame });
  }

  async function loadWatchlist() {
    if (demo) {
      state.watchlist = ["SKHY", "CRWV", "NVDA", "AMD", "MU", "TSLA"].map((symbol) => ({ symbol, name: "ข้อมูลตัวอย่าง", id: symbol }));
      state.pulse = state.watchlist.map((item) => ({ symbol: item.symbol, price: demoChain(item.symbol, "call").underlying.price }));
      renderWatchlist();
      return;
    }
    const [{ data: watchlist, error: watchError }, { data: pulse, error: pulseError }] = await Promise.all([
      state.db.from("watchlist_items").select("instrument_id,created_at").order("created_at"),
      state.db.from("market_pulse_latest").select("symbol,price,market_time,fetched_at,is_watchlist").eq("is_watchlist", true)
    ]);
    if (watchError) throw new Error(`Watchlist: ${watchError.message}`);
    if (pulseError) throw new Error(`Market Pulse: ${pulseError.message}`);
    state.pulse = pulse || [];
    const ids = [...new Set((watchlist || []).map((item) => item.instrument_id).filter(Boolean))];
    if (!ids.length) { state.watchlist = []; renderWatchlist(); return; }
    const { data: instruments, error: instrumentError } = await state.db.from("instruments").select("id,symbol,display_name,asset_type").in("id", ids);
    if (instrumentError) throw new Error(`Instruments: ${instrumentError.message}`);
    const byId = new Map((instruments || []).map((row) => [row.id, row]));
    state.watchlist = ids.map((id) => byId.get(id)).filter((row) => row && ["stock", "etf"].includes(row.asset_type)).map((row) => ({ id: row.id, symbol: String(row.symbol).toUpperCase(), name: row.display_name || row.symbol }));
    renderWatchlist();
  }

  async function resolveInstrument(symbol) {
    const known = state.watchlist.find((item) => item.symbol === symbol);
    if (known) return known.id;
    if (demo) return symbol;
    const { data, error } = await state.db.from("instruments").select("id,symbol,asset_type").eq("symbol", symbol).in("asset_type", ["stock", "etf"]).limit(1);
    if (error) return null;
    return data?.[0]?.id || null;
  }

  async function loadSymbol(symbol, { expiry = "", refresh = false } = {}) {
    const normalized = String(symbol || "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized)) { setStatus("กรอก ticker หุ้นสหรัฐให้ถูกต้อง", true); return; }
    const requestId = ++state.requestId;
    const symbolChanged = normalized !== state.symbol;
    state.symbol = normalized;
    state.busy = true;
    state.lastError = "";
    if (symbolChanged) { state.call = null; state.put = null; state.expiry = ""; state.contractSymbol = ""; state.charts = {}; }
    setStatus("กำลังอ่านราคา กราฟ และ option chain…");
    renderAll();
    try {
      const instrumentId = symbolChanged || !state.instrumentId ? await resolveInstrument(normalized) : state.instrumentId;
      const [callResult, putResult, ...chartResults] = await Promise.allSettled([
        getOptionChain(normalized, "call", expiry), getOptionChain(normalized, "put", expiry),
        ...((symbolChanged || refresh) ? ["M60", "M240", "D"].map((frame) => getChart(instrumentId, frame, normalized)) : [])
      ]);
      if (requestId !== state.requestId) return;
      state.instrumentId = instrumentId;
      state.call = callResult.status === "fulfilled" ? callResult.value : null;
      state.put = putResult.status === "fulfilled" ? putResult.value : null;
      state.expiry = state.call?.expiry || state.put?.expiry || expiry;
      if (symbolChanged || refresh) ["M60", "M240", "D"].forEach((frame, index) => { state.charts[frame] = chartResults[index]?.status === "fulfilled" ? chartResults[index].value : null; });
      const errors = [callResult, putResult].filter((result) => result.status === "rejected").map((result) => result.reason?.message || "Option chain unavailable");
      if (!instrumentId && !demo) errors.push("กราฟใช้ได้เฉพาะหุ้นที่อยู่ในรายการ instruments ของ PCC");
      if (state.call || state.put) setStatus(errors.length ? `ข้อมูลบางส่วนยังไม่พร้อม: ${[...new Set(errors)].join(" · ")}` : "");
      else setStatus(errors.length ? [...new Set(errors)].join(" · ") : "ไม่พบ option chain", true);
    } catch (error) {
      if (requestId !== state.requestId) return;
      setStatus(error.message || "อ่านข้อมูลไม่สำเร็จ", true);
    } finally {
      if (requestId === state.requestId) { state.busy = false; renderAll(); }
    }
  }

  async function showDesk(user) {
    state.user = user;
    $("#auth-shell").hidden = true;
    $("#app-shell").hidden = false;
    $("#account-name").textContent = demo ? "ตัวอย่างในเครื่อง" : user?.email || "PCC member";
    try {
      await loadWatchlist();
      await loadSymbol(state.watchlist[0]?.symbol || "NVDA");
    } catch (error) {
      setStatus(error.message || "โหลดรายการหุ้นไม่สำเร็จ", true);
      renderAll();
    }
  }

  function showLogin() {
    state.requestId++;
    state.user = null;
    clearChart();
    $("#app-shell").hidden = true;
    $("#auth-shell").hidden = false;
  }

  async function init() {
    if (demo) { await showDesk({ email: "preview@local" }); return; }
    if (!config?.supabaseUrl || !config?.supabasePublishableKey || !window.supabase?.createClient) {
      $("#auth-shell").hidden = false;
      $("#auth-message").textContent = "โหลดการเชื่อมต่อ PCC ไม่สำเร็จ กรุณารีเฟรชหน้า";
      return;
    }
    state.db = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const { data: { session } } = await state.db.auth.getSession();
    if (session?.user) await showDesk(session.user); else showLogin();
    state.db.auth.onAuthStateChange((event, session) => { if (event === "SIGNED_OUT" && !session) showLogin(); });
  }

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    button.disabled = true;
    $("#auth-message").textContent = "กำลังเข้าสู่ระบบ…";
    try {
      const { data, error } = await state.db.auth.signInWithPassword({ email: form.email.value.trim(), password: form.password.value });
      if (error) throw error;
      form.password.value = "";
      await showDesk(data.user);
    } catch (error) {
      $("#auth-message").textContent = error.message || "เข้าสู่ระบบไม่สำเร็จ";
    } finally { button.disabled = false; }
  });
  $("#sign-out").addEventListener("click", async () => { if (!demo) await state.db.auth.signOut(); else location.href = location.pathname; });
  $("#watch-search").addEventListener("input", (event) => { state.search = event.target.value.trim().toUpperCase(); renderWatchlist(); });
  $("#watch-list").addEventListener("click", (event) => { const button = event.target.closest("[data-symbol]"); if (button) loadSymbol(button.dataset.symbol); });
  $("#symbol-form").addEventListener("submit", (event) => { event.preventDefault(); loadSymbol($("#symbol-input").value); });
  $("#refresh-button").addEventListener("click", () => loadSymbol(state.symbol, { expiry: state.expiry, refresh: true }));
  $("#chart-frames").addEventListener("click", (event) => { const button = event.target.closest("[data-frame]"); if (button) { state.chartFrame = button.dataset.frame; renderChart(); } });
  $("#expiry-select").addEventListener("change", (event) => loadSymbol(state.symbol, { expiry: event.target.value }));
  $("#option-side").addEventListener("click", (event) => { const button = event.target.closest("[data-side]"); if (button) { state.side = button.dataset.side; state.contractSymbol = ""; renderContract(); } });
  $("#contract-list").addEventListener("click", (event) => { const button = event.target.closest("[data-contract]"); if (button) { state.contractSymbol = button.dataset.contract; renderContract(); } });
  $("#oi-rows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-pick-strike]");
    if (!button) return;
    state.side = button.dataset.pickSide;
    const selected = contracts(state.side).find((item) => Number(item.strike) === Number(button.dataset.pickStrike));
    state.contractSymbol = selected?.symbol || "";
    renderContract();
    if (matchMedia("(max-width: 760px)").matches) $(".contract-panel").scrollIntoView({ behavior: "smooth" });
  });

  init();
})();

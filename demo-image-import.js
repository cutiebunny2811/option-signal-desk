(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskImageImport = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const fixedScript = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js";
  let scriptPromise;

  function loadOcr() {
    if (globalThis.Tesseract?.createWorker) return Promise.resolve(globalThis.Tesseract);
    if (!scriptPromise) scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = fixedScript;
      script.onload = () => globalThis.Tesseract?.createWorker ? resolve(globalThis.Tesseract) : reject(new Error("โหลดตัวอ่านภาพไม่สำเร็จ"));
      script.onerror = () => reject(new Error("โหลดตัวอ่านภาพไม่สำเร็จ · ตรวจอินเทอร์เน็ตแล้วลองใหม่"));
      document.head.append(script);
    }).catch((error) => { scriptPromise = null; throw error; });
    return scriptPromise;
  }

  async function recognizeFiles(files, progress = () => {}) {
    const engine = await loadOcr();
    const worker = await engine.createWorker(["eng", "tha"], 1, {
      logger: ({ status, progress: amount }) => {
        if (status === "recognizing text") progress(`กำลังอ่านภาพ ${Math.round((amount || 0) * 100)}%`);
      }
    });
    try {
      const texts = [];
      for (let index = 0; index < files.length; index++) {
        progress(`กำลังอ่านรูป ${index + 1}/${files.length}…`);
        const { data } = await worker.recognize(files[index]);
        texts.push(data.text || "");
      }
      return texts;
    } finally {
      await worker.terminate();
    }
  }

  const error = (message) => { throw new Error(message); };
  const compactThai = (value) => value.replace(/\s+/g, "");
  const filledPricePattern = /(?:US\$|\$)?\s*(\d{1,6}\.\d{2,4})\b/i;
  const roundCents = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
  const thaiDateTime = (time) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(time);
    const part = (name) => parts.find((item) => item.type === name)?.value || "00";
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
  };

  function parseFilledImageText(rawText, expectedAction) {
    if (!["buy", "sell"].includes(expectedAction)) error("ต้องระบุว่ารูปนี้เป็นซื้อหรือขาย");
    const text = String(rawText || "").normalize("NFKC");
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const optionIndex = lines.findIndex((line) => /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2,4}\b/i.test(line) && /\b(?:Call|Put)\b/i.test(line));
    if (optionIndex < 0) error("อ่านวันหมดอายุหรือฝั่ง CALL/PUT ไม่ได้ · ใช้รูปหน้ารายละเอียด Filled ที่เห็นชื่อสัญญาชัดเจน");
    const option = lines[optionIndex].match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})(?:\s*\(W\))?\s+(Call|Put)\s+(\d+)\b/i);
    if (!option) error("อ่านชื่อสัญญาไม่ครบ · ตรวจรูปที่แนบ");
    const [, day, month, year, side, multiplier] = option;
    const expiry = `${Number(year) < 100 ? 2000 + Number(year) : Number(year)}-${String(months[month.toLowerCase()]).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
    const header = lines.slice(0, optionIndex);
    const tickerCandidates = (header.at(-1) || "").match(/\b[A-Z][A-Z0-9.-]{0,9}\b/g) || [];
    const symbol = tickerCandidates.filter((item) => !["PM", "AM", "US", "USD", "EDT", "EST"].includes(item)).at(-1) || null;
    const strikeMatch = header.at(-1)?.match(/\b(\d+(?:\.\d+)?)\s*$/);
    const strike = strikeMatch ? Number(strikeMatch[1]) : null;
    const afterOption = lines.slice(optionIndex + 1);
    const firstPriceIndex = afterOption.findIndex((line) => filledPricePattern.test(line));
    if (firstPriceIndex < 0) error("อ่านราคาเฉลี่ยที่จับคู่จริงไม่ได้ · อย่าใช้ราคาลิมิตหรือ Mid Price แทน");
    const price = Number(afterOption[firstPriceIndex].match(filledPricePattern)[1]);
    const quantityLines = afterOption.slice(0, firstPriceIndex);
    const quantities = quantityLines.flatMap((line) => [...line.matchAll(/(?:^|\s)(\d{1,5})(?=\s|$)/g)].map((match) => Number(match[1])));
    if (quantities.length < 2) error("อ่านจำนวนทั้งหมด/จำนวนที่จับคู่แล้วไม่ครบ · ตรวจรูปที่แนบ");
    const [ordered, filled] = quantities.slice(-2);
    if (!filled || ordered !== filled) error("คำสั่งยังจับคู่ไม่ครบ หรือจำนวนที่อ่านได้ไม่ตรงกัน · ยังไม่สร้างรายการปิดแล้ว");
    const fillLine = afterOption.slice(firstPriceIndex + 1).find((line) => /\b\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+(?:EDT|EST)\b/i.test(line) && (/จับคู่/.test(compactThai(line)) || /filled/i.test(line)));
    if (!fillLine) error("อ่านเวลา Filled และเขตเวลา EDT/EST ไม่ได้ · ต้องใช้เวลาจับคู่ ไม่ใช่เวลาส่งคำสั่ง");
    const fill = fillLine.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(EDT|EST)/i);
    const offsetHours = fill[7].toUpperCase() === "EDT" ? 4 : 5;
    const filledAt = new Date(Date.UTC(Number(fill[3]), Number(fill[1]) - 1, Number(fill[2]), Number(fill[4]) + offsetHours, Number(fill[5]), Number(fill[6])));
    if (!Number.isFinite(filledAt.getTime())) error("เวลา Filled ไม่ถูกต้อง");
    const actionText = compactThai(lines.slice(optionIndex + 1, optionIndex + 4).join(""));
    if (expectedAction === "buy" && actionText.includes("ขาย")) error("รูปช่องซื้อดูเหมือนคำสั่งขาย · สลับรูปให้ถูกช่อง");
    if (expectedAction === "sell" && actionText.includes("ซื้อ")) error("รูปช่องขายดูเหมือนคำสั่งซื้อ · สลับรูปให้ถูกช่อง");
    return { symbol, strike, expiry, optionSide: side.toLowerCase(), multiplier: Number(multiplier), contracts: filled, price, filledAt: filledAt.toISOString(), bangkokTime: thaiDateTime(filledAt), action: expectedAction };
  }

  function buildClosedTrade(buy, sell) {
    if (!buy || !sell || buy.action !== "buy" || sell.action !== "sell") error("ต้องมีรูปซื้อและรูปขายที่จับคู่แล้ว");
    if (buy.expiry !== sell.expiry || buy.optionSide !== sell.optionSide || buy.multiplier !== sell.multiplier) error("รูปซื้อ–ขายไม่ใช่สัญญาเดียวกัน");
    if (buy.symbol && sell.symbol && buy.symbol !== sell.symbol) error("Ticker ในรูปซื้อ–ขายไม่ตรงกัน");
    if (buy.strike !== null && sell.strike !== null && buy.strike !== sell.strike) error("Strike ในรูปซื้อ–ขายไม่ตรงกัน");
    if (buy.contracts !== sell.contracts) error("จำนวนซื้อ–ขายไม่เท่ากัน · รองรับเฉพาะรายการที่ปิดครบแล้ว");
    if (buy.multiplier !== 100) error("ยังรองรับเฉพาะสัญญา Option ที่ตัวคูณ 100");
    if (Date.parse(sell.filledAt) < Date.parse(buy.filledAt)) error("เวลาขายก่อนเวลาซื้อ · ตรวจรูปที่แนบ");
    const symbol = buy.symbol || sell.symbol, strike = buy.strike ?? sell.strike;
    if (!symbol || !Number.isFinite(strike)) error("อ่าน Ticker หรือ Strike ไม่ได้ครบ · ลองรูปที่ชัดขึ้น หรือจดเอง");
    return {
      contract_label: `${symbol} ${strike} ${buy.optionSide.toUpperCase()} · ${buy.expiry}`,
      underlying_symbol: symbol, option_side: buy.optionSide, contracts: buy.contracts,
      buy_total: roundCents(buy.price * buy.contracts * buy.multiplier),
      sell_total: roundCents(sell.price * sell.contracts * sell.multiplier),
      fees_total: 0, opened_at: buy.bangkokTime, closed_at: sell.bangkokTime,
      followed_signal: false, notes: ""
    };
  }

  return { loadOcr, recognizeFiles, parseFilledImageText, buildClosedTrade };
});

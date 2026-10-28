(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskImageImport = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  // OCR commonly reads "30 Oct 26" as "300ct26" and drops the opening parenthesis of (W).
  const optionPattern = /\b(\d{1,2})\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|0ct|Nov|Dec)\s*(\d{2,4})\b(?:\s*\(?W\)?)?\s+(Call|Put)\s+(\d+)\b/i;
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
        texts.push({ text: data.text || "", headerText: "" });
      }
      // Thai OCR is useful for the fill labels, but can mangle the small English
      // contract line on iPhone screenshots. Read only that header again in English.
      if (texts.some(({ text }) => !optionPattern.test(text))) {
        await worker.reinitialize("eng");
        for (let index = 0; index < files.length; index++) {
          if (optionPattern.test(texts[index].text)) continue;
          progress(`กำลังตรวจชื่อสัญญารูป ${index + 1}/${files.length}…`);
          const header = await cropHeader(files[index]);
          try {
            const { data } = await worker.recognize(header.canvas);
            texts[index].headerText = data.text || "";
          } finally {
            URL.revokeObjectURL(header.url);
          }
        }
      }
      return texts;
    } finally {
      await worker.terminate();
    }
  }

  async function cropHeader(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      const loaded = img.decode ? null : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
      img.src = url;
      if (img.decode) await img.decode();
      else await loaded;
      const canvas = document.createElement("canvas");
      const headerHeight = Math.min(img.naturalHeight, Math.max(img.naturalWidth * 0.55, img.naturalHeight * 0.26));
      const scale = Math.min(2, 1600 / img.naturalWidth);
      canvas.width = Math.ceil(img.naturalWidth * scale);
      canvas.height = Math.ceil(headerHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, img.naturalWidth, headerHeight, 0, 0, canvas.width, canvas.height);
      return { canvas, url };
    } catch (cause) {
      URL.revokeObjectURL(url);
      throw cause;
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
    const text = String(typeof rawText === "string" ? rawText : rawText?.text || "").normalize("NFKC");
    const headerText = String(typeof rawText === "string" ? "" : rawText?.headerText || "").normalize("NFKC");
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const optionIndex = lines.findIndex((line) => optionPattern.test(line));
    const fallbackLines = headerText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const fallbackIndex = fallbackLines.findIndex((line) => optionPattern.test(line));
    if (optionIndex < 0 && fallbackIndex < 0) error("ตัวอ่านภาพจับวันหมดอายุหรือฝั่ง CALL/PUT ไม่ได้");
    const option = optionIndex >= 0 ? lines[optionIndex].match(optionPattern) : fallbackLines[fallbackIndex].match(optionPattern);
    if (!option) error("อ่านชื่อสัญญาไม่ครบ · ตรวจรูปที่แนบ");
    const [, day, month, year, side, multiplier] = option;
    const monthNumber = months[month.toLowerCase() === "0ct" ? "oct" : month.toLowerCase()];
    const expiry = `${Number(year) < 100 ? 2000 + Number(year) : Number(year)}-${String(monthNumber).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
    const anchorIndex = optionIndex >= 0 ? optionIndex : lines.findIndex((line) => /\b(?:call|put)\b/i.test(line));
    const quantityIndex = lines.findIndex((line) => compactThai(line).includes("ทั้งหมด"));
    const bodyStart = anchorIndex >= 0 ? anchorIndex + 1 : quantityIndex >= 0 ? quantityIndex : -1;
    if (bodyStart < 0) error("อ่านตำแหน่งข้อมูลราคาและจำนวนในรูปไม่ได้");
    const header = lines.slice(0, anchorIndex >= 0 ? anchorIndex : bodyStart);
    const tickerCandidates = (header.at(-1) || "").match(/\b[A-Z][A-Z0-9.-]{0,9}\b/g) || [];
    let symbol = tickerCandidates.filter((item) => !["PM", "AM", "US", "USD", "EDT", "EST"].includes(item)).at(-1) || null;
    const strikeMatch = header.at(-1)?.match(/\b(\d+(?:\.\d+)?)\s*$/);
    let strike = strikeMatch ? Number(strikeMatch[1]) : null;
    let symbolSource = symbol ? "primary" : null;
    if (fallbackIndex >= 0) {
      const fallbackHeader = fallbackLines.slice(0, fallbackIndex);
      const fallbackCandidates = (fallbackHeader.at(-1) || "").match(/\b[A-Z][A-Z0-9.-]{1,9}\b/g) || [];
      if (!symbol) {
        symbol = fallbackCandidates.filter((item) => !["PM", "AM", "US", "USD", "EDT", "EST"].includes(item)).at(-1) || null;
        if (symbol) symbolSource = "fallback";
      }
      if (strike === null) {
        const fallbackStrike = fallbackHeader.at(-1)?.match(/\b(\d+(?:\.\d+)?)\s*$/);
        strike = fallbackStrike ? Number(fallbackStrike[1]) : null;
      }
    }
    const afterOption = lines.slice(bodyStart);
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
    const actionText = compactThai(lines.slice(Math.max(0, bodyStart - 2), bodyStart + 3).join(""));
    if (expectedAction === "buy" && actionText.includes("ขาย")) error("รูปช่องซื้อดูเหมือนคำสั่งขาย · สลับรูปให้ถูกช่อง");
    if (expectedAction === "sell" && actionText.includes("ซื้อ")) error("รูปช่องขายดูเหมือนคำสั่งซื้อ · สลับรูปให้ถูกช่อง");
    return { symbol, symbolSource, strike, expiry, optionSide: side.toLowerCase(), multiplier: Number(multiplier), contracts: filled, price, filledAt: filledAt.toISOString(), bangkokTime: thaiDateTime(filledAt), action: expectedAction };
  }

  function buildClosedTrade(buy, sell) {
    if (!buy || !sell || buy.action !== "buy" || sell.action !== "sell") error("ต้องมีรูปซื้อและรูปขายที่จับคู่แล้ว");
    if (buy.expiry !== sell.expiry || buy.optionSide !== sell.optionSide || buy.multiplier !== sell.multiplier) error("รูปซื้อ–ขายไม่ใช่สัญญาเดียวกัน");
    if (buy.symbol && sell.symbol && buy.symbol !== sell.symbol) {
      const uncertain = buy.symbolSource === "fallback" ? buy : sell.symbolSource === "fallback" ? sell : null;
      const certain = uncertain === buy ? sell : buy;
      if (!uncertain || certain.symbolSource !== "primary" || !certain.symbol.endsWith(uncertain.symbol) || certain.symbol.length - uncertain.symbol.length !== 1) error("Ticker ในรูปซื้อ–ขายไม่ตรงกัน");
    }
    if (buy.strike !== null && sell.strike !== null && buy.strike !== sell.strike) error("Strike ในรูปซื้อ–ขายไม่ตรงกัน");
    if (buy.contracts !== sell.contracts) error("จำนวนซื้อ–ขายไม่เท่ากัน · รองรับเฉพาะรายการที่ปิดครบแล้ว");
    if (buy.multiplier !== 100) error("ยังรองรับเฉพาะสัญญา Option ที่ตัวคูณ 100");
    if (Date.parse(sell.filledAt) < Date.parse(buy.filledAt)) error("เวลาขายก่อนเวลาซื้อ · ตรวจรูปที่แนบ");
    const symbol = buy.symbolSource === "primary" ? buy.symbol : sell.symbolSource === "primary" ? sell.symbol : buy.symbol || sell.symbol;
    const strike = buy.strike ?? sell.strike;
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

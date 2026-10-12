(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OptionDeskApiError = api;
})(typeof globalThis === "undefined" ? null : globalThis, function () {
  "use strict";

  function isRateLimited(value) {
    if (value && typeof value === "object") {
      if (Number(value.status ?? value.statusCode ?? value.httpCode) === 429) return true;
      return isRateLimited(value.message ?? value.error ?? "");
    }
    const message = String(value || "");
    return /"(?:httpCode|statusCode|status)"\s*:\s*429\b|\bHTTP\s*429\b|\btoo many requests\b|\brate[ -]?limit(?:ed|ing)?\b/i.test(message);
  }

  function describe(value) {
    const message = String(value?.message ?? value ?? "");
    if (/Webull option contracts failed/i.test(message) && /"httpCode"\s*:\s*404\b|\bHTTP\s*404\b/i.test(message)) {
      return "Webull OpenAPI ยังไม่ส่งรายการสัญญา Option (404) · ตรวจสิทธิ์ Option market data สำหรับ API กับ Webull; กราฟหุ้นยังใช้ได้";
    }
    return message || "แหล่งข้อมูลไม่พร้อม";
  }

  return { isRateLimited, describe };
});

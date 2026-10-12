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

  return { isRateLimited };
});

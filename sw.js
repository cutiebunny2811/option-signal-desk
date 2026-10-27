self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch (_) { /* Ignore malformed payload. */ }
  const title = typeof payload.title === "string" ? payload.title : "Option Signal Desk";
  const body = typeof payload.body === "string" ? payload.body : "มีข้อมูลใหม่ในหุ้นเฝ้าเทรด";
  const symbol = /^[A-Z][A-Z0-9.-]{0,9}$/.test(payload.symbol || "") ? payload.symbol : "";
  event.waitUntil(self.registration.showNotification(title, {
    body, tag: typeof payload.tag === "string" ? payload.tag : "option-desk-alert",
    icon: new URL("app-icon-luxury.png", self.registration.scope).href,
    badge: new URL("app-icon-luxury.png", self.registration.scope).href,
    data: { symbol },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const symbol = event.notification.data?.symbol || "";
  const target = new URL(self.registration.scope);
  if (symbol) target.searchParams.set("symbol", symbol);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: "OPEN_SYMBOL", symbol });
    } else await self.clients.openWindow(target.href);
  })());
});

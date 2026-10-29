// Cordial Co-Parenting service worker: phone alerts (incl. incoming calls when the app is closed) and the red number on the icon.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  var call = d.kind === "call";
  e.waitUntil((async function () {
    await self.registration.showNotification(d.title || "Cordial Co-Parenting", {
      body: d.body || "", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
      tag: d.tag || undefined, renotify: !!d.tag, requireInteraction: call,
      vibrate: call ? [400, 200, 400, 200, 400, 200, 400] : undefined,
      data: { url: d.url || "/" },
    });
    if (typeof d.badge === "number" && self.navigator && self.navigator.setAppBadge) {
      try { await self.navigator.setAppBadge(d.badge); } catch (x) {}
    }
  })());
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) { if ("focus" in cs[i]) return cs[i].focus(); }
    return self.clients.openWindow(url);
  }));
});

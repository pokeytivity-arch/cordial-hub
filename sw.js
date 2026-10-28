// Cordial Co-Parenting service worker: lets the home-screen app show alerts and the red number on its icon.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil((async function () {
    await self.registration.showNotification(d.title || "Cordial Co-Parenting", {
      body: d.body || "", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: d.url || "/" },
    });
    if (typeof d.badge === "number" && self.navigator && self.navigator.setAppBadge) {
      try { await self.navigator.setAppBadge(d.badge); } catch (x) {}
    }
  })());
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) { if ("focus" in cs[i]) return cs[i].focus(); }
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || "/");
  }));
});

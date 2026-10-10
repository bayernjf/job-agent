/**
 * JobAgent push service worker (decision #25). Minimal shell:
 * push -> showNotification; notificationclick -> open/focus the workbench.
 */
self.addEventListener('push', (event) => {
  let data = { title: 'JobAgent', body: '', url: '/zh-CN/workbench' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: data.url },
      icon: '/favicon.svg',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/zh-CN/workbench';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (client.url.includes('/workbench') && 'focus' in client) return client.focus();
        }
        return self.clients.openWindow(url);
      }),
  );
});

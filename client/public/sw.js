// Service Worker — handles push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/chat-icon.png',
      badge: '/chat-icon.png',
      tag: `livechat-${data.room}`,
      renotify: true,
      data: { room: data.room },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing tab if open
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      // Otherwise open new tab
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

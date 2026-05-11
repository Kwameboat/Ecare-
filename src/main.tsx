import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Hotfix: legacy cache-first service worker was intercepting /api requests and causing
// stalled/failed chat fetches. Unregister old workers so network calls hit backend directly.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .getRegistrations()
      .then(async (registrations) => {
        for (const reg of registrations) {
          await reg.unregister();
        }
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      })
      .catch((e) => {
        console.warn("SW cleanup skipped:", e);
      });
  });
}

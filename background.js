/* background.js – Fetch-Proxy für YouTube-Streams
 *
 * In Manifest V3 unterliegen Content-Scripts der CORS-Policy der Seite
 * (Firefox seit Version 101). Der Hintergrund-Service-Worker hat dagegen
 * die Host-Permission und darf cross-origin laden.
 *
 * Das Content-Script öffnet einen Port ("fetch") und schickt { url }.
 * Der Hintergrund antwortet mit:
 *   { meta: { status, contentLength, contentType } }
 *   { chunk: Uint8Array }          (in 256-KB-Stücken)
 *   { done: true }  bzw.  { error: "..." }
 */
'use strict';

const MAX_CHUNK = 256 * 1024;

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fetch') return;

  const abort = new AbortController();
  let active = false;

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg.url !== 'string' || active) return;
    active = true;
    try {
      const resp = await fetch(msg.url, { signal: abort.signal, credentials: 'include' });

      port.postMessage({
        meta: {
          status: resp.status,
          contentLength: resp.headers.get('content-length'),
          contentType: resp.headers.get('content-type')
        }
      });

      if (!resp.ok || !resp.body) {
        port.postMessage({ error: `HTTP-Fehler ${resp.status}` });
        return;
      }

      const reader = resp.body.getReader();
      let leftover = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (leftover) {
          const buf = new Uint8Array(leftover.length + value.length);
          buf.set(leftover, 0);
          buf.set(value, leftover.length);
          leftover = buf;
        } else {
          leftover = value;
        }
        while (leftover.length > MAX_CHUNK) {
          port.postMessage({ chunk: leftover.slice(0, MAX_CHUNK) });
          leftover = leftover.slice(MAX_CHUNK);
        }
      }
      if (leftover && leftover.length) {
        port.postMessage({ chunk: leftover });
      }
      port.postMessage({ done: true });
    } catch (e) {
      if (!e || e.name !== 'AbortError') {
        try {
          port.postMessage({ error: (e && e.message) || String(e) });
        } catch (_) { /* Port bereits zu */ }
      }
    } finally {
      active = false;
    }
  });

  port.onDisconnect.addListener(() => {
    try { abort.abort(); } catch (_) { /* ignorieren */ }
  });
});

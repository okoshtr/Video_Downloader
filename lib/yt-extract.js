/* lib/yt-extract.js – MAIN-Welt-Shim (läuft in der Seite, vor content.js)
 *
 * Problem: Content-Scripts laufen in der ISOLIERTEN Welt und sehen die
 * JS-Globalen der Seite NICHT – `window.ytInitialPlayerResponse` ist dort
 * undefined. Dieser Shim läuft in der MAIN Welt, liest die Player-Daten
 * der Seite aus und schreibt sie als JSON in ein DOM-Element
 * (<template id="ytdl-data" data-ytdl="…">). Das DOM wird von beiden
 * Welten geteilt, dadurch kommt content.js (isolierte Welt) an die Daten.
 */
(() => {
  'use strict';

  if (globalThis.__YTDL_SHIM__) return;
  globalThis.__YTDL_SHIM__ = true;

  const HOLDER_ID = 'ytdl-data';
  const ATTR = 'data-ytdl';

  let lastFingerprint = '';
  let lastJson = '';

  function getPlayerResponse() {
    const pr = globalThis.ytInitialPlayerResponse;
    if (pr && pr.videoDetails && pr.videoDetails.videoId) return pr;
    // Fallback: Player-Konfig (u. a. bei eingebetteten/verzögertem Player)
    const pc = globalThis.ytPlayerConfig;
    if (pc && pc.args && pc.args.playerResponse &&
        pc.args.playerResponse.videoDetails &&
        pc.args.playerResponse.videoDetails.videoId) {
      return pc.args.playerResponse;
    }
    return null;
  }

  function pickFormat(f) {
    if (!f) return null;
    return {
      url: f.url || '',
      vcodec: f.vcodec || '',
      acodec: f.acodec || '',
      width: f.width || 0,
      height: f.height || 0,
      bitrate: f.bitrate || 0,
      audioSampleRate: f.audioSampleRate || 0
    };
  }

  function post() {
    const pr = getPlayerResponse();
    if (!pr) return;
    const vd = pr.videoDetails;
    const sd = pr.streamingData || {};
    const nFmt = (sd.formats || []).length;
    const nAdapt = (sd.adaptiveFormats || []).length;
    const fingerprint = vd.videoId + '|' + nFmt + '|' + nAdapt;
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;

    let json;
    try {
      json = JSON.stringify({
        videoId: vd.videoId,
        title: vd.title || '',
        isLive: String(vd.isLive) === 'true' ||
          String(vd.isLiveContent) === 'true',
        playability: pr.playabilityStatus ? pr.playabilityStatus.status : 'OK',
        formats: (sd.formats || []).map(pickFormat),
        adaptiveFormats: (sd.adaptiveFormats || []).map(pickFormat)
      });
    } catch (_) {
      return;
    }
    if (json === lastJson) return;
    lastJson = json;

    let holder = document.getElementById(HOLDER_ID);
    if (!holder) {
      holder = document.createElement('template');
      holder.id = HOLDER_ID;
      const target = document.documentElement || document.body;
      if (!target) return;
      target.appendChild(holder);
    }
    holder.setAttribute(ATTR, json);
  }

  post();
  // Regelmäßig neu prüfen: ytInitialPlayerResponse kann nachgeladen
  // werden (SPA-Navigation, verzögerter Player). Billiger Check pro Tick
  // (nur Fingerprint), JSON wird nur bei Änderungen neu serialisiert.
  setInterval(post, 500);
})();

/* content.js – YouTube Downloader
 *
 * Zeigt auf YouTube-Videoseiten einen Download-Button unter dem Player an
 * und stellt bereit:
 *   - Video als MP4: progressive Formate direkt, höhere Qualitäten per
 *     DASH-Merging (Video- + Audio-Track) – alles im Browser.
 *   - Audio als MP3: Audiospur wird dekodiert (WebCodecs, Fallback:
 *     Web Audio API) und mit lamejs zu MP3 encodiert.
 *
 * Netzverkehr läuft über den Hintergrund-Proxy (background.js), da
 * Content-Scripts in Manifest V3 CORS unterliegen.
 */
(() => {
  'use strict';

  if (globalThis.__YTDL_LOADED__) return;
  globalThis.__YTDL_LOADED__ = true;

  /* =========================================================
   * Kleine Helfer
   * ========================================================= */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sanitizeName(s, max = 180) {
    s = String(s || 'video')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (s.length > max) s = s.slice(0, max).trim();
    return s || 'video';
  }

  function formatBytes(n) {
    if (!isFinite(n) || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function abortError() {
    return new DOMException('Abgebrochen', 'AbortError');
  }

  /* =========================================================
   * Stream-Lesen über den Hintergrund-Proxy
   * ========================================================= */

  /**
   * Öffnet einen Fetch-Port und liefert eine Pull-API:
   *   meta()  -> { status, contentLength, contentType }
   *   read()  -> { value: Uint8Array, done: false } | { value: undefined, done: true }
   *   cancel()
   */
  function fetchStream(url) {
    const port = browser.runtime.connect({ name: 'fetch' });
    const chunks = [];
    const waiters = [];
    let meta = null;
    let done = false;
    let error = null;

    function notify() {
      while (waiters.length && (chunks.length || done || error || meta)) {
        waiters.shift()();
      }
    }

    port.onMessage.addListener((m) => {
      if (!m) return;
      if (m.meta) meta = m.meta;
      else if (m.chunk) chunks.push(m.chunk);
      else if (m.done) done = true;
      else if (m.error) error = new Error(m.error);
      notify();
    });

    port.onDisconnect.addListener(() => {
      if (!done && !error) {
        error = new Error('Die Verbindung zum Hintergrundskript wurde getrennt.');
        notify();
      }
    });

    port.postMessage({ url });

    return {
      async meta() {
        while (!meta && !error) {
          await new Promise((r) => waiters.push(r));
        }
        if (error) throw error;
        return meta;
      },
      async read() {
        while (!chunks.length && !done && !error) {
          await new Promise((r) => waiters.push(r));
        }
        if (error) throw error;
        if (chunks.length) return { value: chunks.shift(), done: false };
        return { value: undefined, done: true };
      },
      cancel() {
        if (done || error) return;
        error = abortError();
        try { port.disconnect(); } catch (_) { /* ignorieren */ }
        notify();
      }
    };
  }

  /** Liest ganze MP4-Boxen aus einem Stream (puffert verbleibende Bytes). */
  class BoxReader {
    constructor(stream) {
      this.stream = stream;
      this.buf = new Uint8Array(0);
    }

    async readBox() {
      for (;;) {
        if (this.buf.length >= 8) {
          let size = (this.buf[0] << 24) | (this.buf[1] << 16) | (this.buf[2] << 8) | this.buf[3];
          let header = 8;
          if (size === 1) {
            if (this.buf.length >= 16) {
              size = Number(this.buf[8]) * 4294967296 +
                ((this.buf[9] << 24) | (this.buf[10] << 16) | (this.buf[11] << 8) | this.buf[12]);
              header = 16;
            }
          } else if (size === 0) {
            size = this.buf.length;
          }
          if (size < header) throw new Error('Ungültige MP4-Box-Größe');
          if (this.buf.length >= size) {
            const type = String.fromCharCode(this.buf[4], this.buf[5], this.buf[6], this.buf[7]);
            const box = this.buf.slice(0, size);
            this.buf = this.buf.slice(size);
            return { type, buf: box };
          }
        }
        const { value, done } = await this.stream.read();
        if (done) {
          // Nur ein unvollständiges "size=0"-Box-Endstück akzeptieren
          if (this.buf.length >= 8 && ((this.buf[0] << 24) | (this.buf[1] << 16) | (this.buf[2] << 8) | this.buf[3]) === 0) {
            const type = String.fromCharCode(this.buf[4], this.buf[5], this.buf[6], this.buf[7]);
            const box = this.buf;
            this.buf = new Uint8Array(0);
            return { type, buf: box };
          }
          return { done: true };
        }
        if (value && value.length) {
          const nb = new Uint8Array(this.buf.length + value.length);
          nb.set(this.buf, 0);
          nb.set(value, this.buf.length);
          this.buf = nb;
        }
      }
    }
  }

  /* =========================================================
   * Video-Infos
   *
   * content.js läuft in der ISOLIERTEN Welt und sieht die Page-Globalen
   * NICHT (window.ytInitialPlayerResponse ist dort undefined).
   * lib/yt-extract.js (MAIN Welt) schreibt die Player-Daten deshalb in
   * ein DOM-Element: <template id="ytdl-data" data-ytdl='…JSON…'>
   * ========================================================= */

  let lastRaw = null;
  let lastParsed = null;

  function readShimData() {
    const holder = document.getElementById('ytdl-data');
    if (!holder) return null;
    const raw = holder.getAttribute('data-ytdl');
    if (!raw) return null;
    if (raw !== lastRaw) {
      try {
        lastParsed = JSON.parse(raw);
      } catch (_) {
        lastParsed = null;
      }
      lastRaw = raw;
    }
    return lastParsed && lastParsed.videoId ? lastParsed : null;
  }

  function codecLabel(vc) {
    if (!vc) return '';
    vc = vc.toLowerCase();
    if (vc.startsWith('avc1')) return 'H.264';
    if (vc.startsWith('vp9') || vc.startsWith('vp09')) return 'VP9';
    if (vc.startsWith('av01')) return 'AV1';
    return vc.slice(0, 6);
  }

  function getVideoInfo() {
    const d = readShimData();
    if (!d) return null;
    const progressiveList = d.formats || [];
    const all = progressiveList.concat(d.adaptiveFormats || []);

    const codecRank = (vc) => {
      const v = (vc || '').toLowerCase();
      if (v.startsWith('avc1')) return 0;
      if (v.startsWith('vp9') || v.startsWith('vp09')) return 1;
      if (v.startsWith('av01')) return 2;
      return 3;
    };

    const qualities = new Map(); // height -> Kandidat
    for (const f of all) {
      if (!f || !f.url || !f.height || !f.vcodec || f.vcodec === 'none') continue;
      const progressive = progressiveList.includes(f);
      const rank = codecRank(f.vcodec);
      const cur = qualities.get(f.height);
      const better = !cur ||
        (cur.progressive !== progressive && progressive) ||
        (cur.progressive === progressive && rank < cur.rank) ||
        (cur.progressive === progressive && rank === cur.rank && (f.bitrate || 0) > (cur.bitrate || 0));
      if (better) {
        qualities.set(f.height, {
          height: f.height,
          codec: codecLabel(f.vcodec),
          url: f.url,
          progressive,
          rank,
          bitrate: f.bitrate || 0
        });
      }
    }

    let bestAudio = null;
    for (const f of all) {
      if (!f || !f.url || !f.acodec || f.acodec === 'none') continue;
      if (f.vcodec && f.vcodec !== 'none') continue; // nur reine Audio-Ströme
      if (!bestAudio || (f.bitrate || 0) > (bestAudio.bitrate || 0)) {
        bestAudio = {
          url: f.url,
          codec: f.acodec,
          bitrate: f.bitrate || 0,
          sampleRate: f.audioSampleRate || 48000
        };
      }
    }

    const progressiveWithAudio = progressiveList.find(
      (f) => f && f.url && f.acodec && f.acodec !== 'none'
    ) || null;

    return {
      videoId: d.videoId,
      title: d.title || 'YouTube-Video',
      isLive: !!d.isLive,
      qualities: Array.from(qualities.values()).sort((a, b) => b.height - a.height),
      audio: bestAudio,
      progressiveAudio: progressiveWithAudio,
      playability: d.playability || 'OK'
    };
  }

  /* =========================================================
   * Download: progressiv (komplette MP4)
   * ========================================================= */

  async function downloadProgressive(url, onProgress, isCancelled) {
    const stream = fetchStream(url);
    try {
      const m = await stream.meta();
      const total = Number(m.contentLength) || 0;
      const parts = [];
      let got = 0;
      for (;;) {
        if (isCancelled()) throw abortError();
        const { value, done } = await stream.read();
        if (done) break;
        if (value && value.length) {
          parts.push(value);
          got += value.length;
          onProgress({ phase: 'download', got, total });
        }
      }
      if (!parts.length) throw new Error('Leere Antwort erhalten');
      return new Blob(parts, { type: 'video/mp4' });
    } finally {
      stream.cancel();
    }
  }

  /* =========================================================
   * Download: DASH-Merge (Video + Audio -> eine MP4)
   * ========================================================= */

  async function downloadMerged(videoUrl, audioUrl, onProgress, isCancelled) {
    const vs = fetchStream(videoUrl);
    const as = fetchStream(audioUrl);

    const cleanup = () => {
      try { vs.cancel(); } catch (_) { /* ignorieren */ }
      try { as.cancel(); } catch (_) { /* ignorieren */ }
    };

    try {
      const vm = await vs.meta();
      const am = await as.meta();
      const total = (Number(vm.contentLength) || 0) + (Number(am.contentLength) || 0);

      const vbr = new BoxReader(vs);
      const abr = new BoxReader(as);

      // Init-Segmente einlesen (bis moov INKLUSIVE)
      const readInit = async (br) => {
        const parts = [];
        for (;;) {
          if (isCancelled()) throw abortError();
          const box = await br.readBox();
          if (box.done) throw new Error('Stream ohne Init-Segment beendet');
          if (box.type === 'moov') {
            parts.push(box.buf); // moov gehört zum Init-Segment!
            break;
          }
          parts.push(box.buf);
        }
        const init = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { init.set(p, o); o += p.length; }
        return init;
      };

      const vInit = await readInit(vbr);
      const aInit = await readInit(abr);

      const merger = new MP4T.DashMerger(vInit, aInit);
      let got = 0;
      const report = () => onProgress({ phase: 'download', got, total });

      async function pump(br, addFragment) {
        for (;;) {
          if (isCancelled()) throw abortError();
          const moofBox = await br.readBox();
          if (moofBox.done) return;
          if (moofBox.type !== 'moof') {
            // Unbekannte Box (z. B. sidx) einfach überspringen
            continue;
          }
          const mdatBox = await br.readBox();
          if (mdatBox.done) throw new Error('Stream ohne mdat beendet');
          if (mdatBox.type !== 'mdat') {
            throw new Error('Unerwartete Box nach moof: ' + mdatBox.type);
          }
          got += moofBox.buf.length + mdatBox.buf.length;
          addFragment(moofBox.buf, mdatBox.buf);
          report();
        }
      }

      const results = await Promise.allSettled([
        pump(vbr, (moof, mdat) => merger.addVideo(moof, mdat)),
        pump(abr, (moof, mdat) => merger.addAudio(moof, mdat))
      ]);

      cleanup();

      const failure = results.find((r) => r.status === 'rejected');
      if (failure) throw failure.reason;

      report();
      return new Blob(merger.finish(), { type: 'video/mp4' });
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  /* =========================================================
   * MP3: Decodierung + lamejs-Encoding
   * ========================================================= */

  function makeMp3Encoder(channels, sampleRate, kbps) {
    const lib = globalThis.lamejs;
    if (!lib || !lib.Mp3Encoder) throw new Error('MP3-Bibliothek (lamejs) fehlt');
    return new lib.Mp3Encoder(channels, sampleRate, kbps);
  }

  function feedEncoderTo(enc, L, R, frames, parts) {
    const CHUNK = 1152;
    for (let i = 0; i < frames; i += CHUNK) {
      const n = Math.min(CHUNK, frames - i);
      const out = enc.encodeInt16(L.subarray(i, i + n), R.subarray(i, i + n));
      if (out && out.length) parts.push(new Uint8Array(out));
    }
  }

  function pcmPlaneToI16(plane, frames) {
    const out = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      let s = plane[i] || 0;
      s = s < -1 ? -1 : (s > 1 ? 1 : s);
      out[i] = s < 0 ? (s * 32768) | 0 : (s * 32767) | 0;
    }
    return out;
  }

  /** Primärpfad: WebCodecs-AudioDecoder + streaming-Encoder. */
  async function mp3ViaWebCodecs(url, codec, sampleRate, kbps, onProgress, isCancelled) {
    if (typeof AudioDecoder === 'undefined') {
      throw new Error('WebCodecs nicht verfügbar');
    }
    const stream = fetchStream(url);
    const br = new BoxReader(stream);
    const parts = [];
    let decoder = null;
    let mp3enc = null;
    let decodeError = null;
    let encodedFrames = 0;
    const sr = sampleRate || 48000;
    let lastUiUpdate = 0;

    try {
      // 1) Init-Segment (bis moov)
      const initParts = [];
      for (;;) {
        if (isCancelled()) throw abortError();
        const box = await br.readBox();
        if (box.done) throw new Error('Stream ohne Init-Segment beendet');
        initParts.push(box.buf);
        if (box.type === 'moov') break;
      }
      const init = new Uint8Array(initParts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of initParts) { init.set(p, o); o += p.length; }
      const timescale = MP4T.timescaleOf(init) || sr;

      // 2) Encoder + Decoder vorbereiten
      mp3enc = makeMp3Encoder(2, sr, kbps);
      const encodeAudioData = (ad) => {
        if (isCancelled()) return;
        try {
          const frames = ad.numberOfFrames;
          const plane = (idx) => {
            if (ad.copyTo) {
              const f = new Float32Array(frames);
              ad.copyTo(f, { planeIndex: idx });
              return f;
            }
            if (ad.getChannelData) return ad.getChannelData(idx);
            throw new Error('AudioData-Lese-API nicht verfügbar');
          };
          const L = pcmPlaneToI16(plane(0), frames);
          const R = ad.numberOfChannels > 1 ? pcmPlaneToI16(plane(1), frames) : L;
          feedEncoderTo(mp3enc, L, R, frames, parts);
          encodedFrames += frames;
          const now = Date.now();
          if (now - lastUiUpdate > 250) {
            lastUiUpdate = now;
            onProgress({ phase: 'encode', sec: encodedFrames / sr });
          }
        } catch (e) {
          decodeError = decodeError || e;
        }
      };

      decoder = new AudioDecoder({
        output: (ad) => {
          encodeAudioData(ad);
          try { if (ad.close) ad.close(); } catch (_) { /* ignorieren */ }
        },
        error: (e) => {
          decodeError = decodeError || new Error('Dekodieren fehlgeschlagen: ' + ((e && e.message) || e));
        }
      });
      decoder.configure({
        codec,
        sampleRate: sr,
        numberOfChannels: 2
      });

      // 3) Fragmente demuxen und dem Decoder zuführen
      for (;;) {
        if (isCancelled()) throw abortError();
        if (decodeError) throw decodeError;
        const moofBox = await br.readBox();
        if (moofBox.done) break;
        if (moofBox.type !== 'moof') continue;
        const mdatBox = await br.readBox();
        if (mdatBox.done) throw new Error('Stream ohne mdat beendet');
        if (mdatBox.type !== 'mdat') {
          throw new Error('Unerwartete Box nach moof: ' + mdatBox.type);
        }
        const frames = MP4T.demuxAudioFrames(moofBox.buf, mdatBox.buf, timescale);
        for (const fr of frames) {
          decoder.decode(
            new EncodedAudioChunk({
              type: 'key',
              timestamp: fr.tsUs,
              duration: fr.durUs,
              data: fr.data
            })
          );
        }
        onProgress({ phase: 'encode', sec: encodedFrames / sr });
      }

      // 4) Flush + Abschluss
      if (decoder.flush) {
        await decoder.flush();
      }
      if (decodeError) throw decodeError;
      try { if (decoder.close) decoder.close(); } catch (_) { /* ignorieren */ }

      const tail = mp3enc.flush();
      if (tail && tail.length) parts.push(new Uint8Array(tail));
      onProgress({ phase: 'encode', sec: encodedFrames / sr, final: true });
      if (!parts.length) throw new Error('Kein Audio dekodiert');
      return new Blob(parts, { type: 'audio/mpeg' });
    } finally {
      try { if (decoder && decoder.state === 'configured') decoder.close(); } catch (_) { /* ignorieren */ }
      stream.cancel();
    }
  }

  /** Fallback: ganze Datei über Web Audio API dekodieren. */
  async function mp3ViaDecodeAudioData(url, kbps, onProgress, isCancelled) {
    const stream = fetchStream(url);
    try {
      const m = await stream.meta();
      const total = Number(m.contentLength) || 0;
      const parts = [];
      let got = 0;
      for (;;) {
        if (isCancelled()) throw abortError();
        const { value, done } = await stream.read();
        if (done) break;
        if (value && value.length) {
          parts.push(value);
          got += value.length;
          onProgress({ phase: 'download', got, total });
        }
      }
      const blob = new Blob(parts, { type: 'audio/mp4' });
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API nicht verfügbar');
      const ctx = new AC();
      let audioBuf;
      try {
        audioBuf = await ctx.decodeAudioData(await blob.arrayBuffer());
      } finally {
        ctx.close().catch(() => {});
      }

      const sr = audioBuf.sampleRate;
      const enc = makeMp3Encoder(2, sr, kbps);
      const outParts = [];
      const L = pcmPlaneToI16(audioBuf.getChannelData(0), audioBuf.length);
      const R = audioBuf.numberOfChannels > 1
        ? pcmPlaneToI16(audioBuf.getChannelData(1), audioBuf.length)
        : L;
      feedEncoderTo(enc, L, R, L.length, outParts);
      const tail = enc.flush();
      if (tail && tail.length) outParts.push(new Uint8Array(tail));
      onProgress({ phase: 'encode', sec: audioBuf.length / sr, final: true });
      return new Blob(outParts, { type: 'audio/mpeg' });
    } finally {
      stream.cancel();
    }
  }

  /** MP3-Download mit automatischem Fallback. */
  async function downloadMp3(url, codec, sampleRate, kbps, onProgress, isCancelled) {
    try {
      return await mp3ViaWebCodecs(url, codec, sampleRate, kbps, onProgress, isCancelled);
    } catch (e) {
      if (isCancelled()) throw abortError();
      if (e && e.name === 'AbortError') throw e;
      // Fallback-Pfad (z. B. fehlende/fehlgeschlagene WebCodecs-Dekodierung)
      return await mp3ViaDecodeAudioData(url, kbps, onProgress, isCancelled);
    }
  }

  /* =========================================================
   * UI
   * ========================================================= */

  let ui = null;
  let job = { active: false, cancel: false };

  function el(id) {
    return document.getElementById(id);
  }

  function buildUI() {
    const root = document.createElement('div');
    root.id = 'ytdl-root';
    root.innerHTML =
      '<button id="ytdl-open" class="ytdl-btn ytdl-main" title="Video oder Audio dieses YouTube-Videos herunterladen">' +
      '<span class="ytdl-ico">&#x2B07;</span> Herunterladen' +
      '</button>' +
      '<div id="ytdl-panel" class="ytdl-panel" hidden>' +
      '<div class="ytdl-head">' +
      '<div id="ytdl-title" class="ytdl-title"></div>' +
      '<button id="ytdl-close" class="ytdl-icon" title="Schließen">&#x2715;</button>' +
      '</div>' +
      '<div class="ytdl-row">' +
      '<div class="ytdl-field">' +
      '<label for="ytdl-q">Video (MP4)</label>' +
      '<select id="ytdl-q"></select>' +
      '</div>' +
      '<button id="ytdl-dlvid" class="ytdl-btn">Video speichern</button>' +
      '</div>' +
      '<div class="ytdl-row">' +
      '<div class="ytdl-field">' +
      '<label for="ytdl-b">Audio (MP3)</label>' +
      '<select id="ytdl-b">' +
      '<option value="128">128 kbps</option>' +
      '<option value="192" selected>192 kbps</option>' +
      '<option value="320">320 kbps</option>' +
      '</select>' +
      '</div>' +
      '<button id="ytdl-dlmp3" class="ytdl-btn">MP3 speichern</button>' +
      '</div>' +
      '<div id="ytdl-prog" class="ytdl-prog" hidden>' +
      '<div class="ytdl-bar"><div id="ytdl-fill" class="ytdl-fill"></div></div>' +
      '<div id="ytdl-status" class="ytdl-status"></div>' +
      '<button id="ytdl-cancel" class="ytdl-btn ytdl-danger">Abbrechen</button>' +
      '</div>' +
      '<div id="ytdl-error" class="ytdl-error" hidden></div>' +
      '</div>';

    root.querySelector('#ytdl-open').addEventListener('click', () => togglePanel());
    root.querySelector('#ytdl-close').addEventListener('click', () => {
      const panel = el('ytdl-panel');
      if (panel) panel.hidden = true;
    });
    root.querySelector('#ytdl-dlvid').addEventListener('click', () => startVideoDownload());
    root.querySelector('#ytdl-dlmp3').addEventListener('click', () => startMp3Download());
    root.querySelector('#ytdl-cancel').addEventListener('click', () => {
      job.cancel = true;
    });
    return root;
  }

  function attachUI() {
    if (document.getElementById('ytdl-root')) return;
    if (!document.body) return;
    const root = buildUI();
    const host = document.querySelector('ytd-player-loaded') ||
      document.querySelector('#movie-container');
    if (host && host.parentElement && host.parentElement !== document.body) {
      root.classList.add('ytdl-inline');
      host.parentElement.insertBefore(root, host.nextSibling);
    } else {
      root.classList.add('ytdl-floating');
      document.body.appendChild(root);
    }
  }

  function setFill(frac) {
    const fill = el('ytdl-fill');
    if (!fill) return;
    if (frac < 0 || !isFinite(frac)) {
      fill.classList.add('indet');
    } else {
      fill.classList.remove('indet');
      fill.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
    }
  }

  function setStatus(text) {
    const s = el('ytdl-status');
    if (s) s.textContent = text;
  }

  function showError(text) {
    const box = el('ytdl-error');
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
  }

  function clearError() {
    const box = el('ytdl-error');
    if (box) { box.hidden = true; box.textContent = ''; }
  }

  function setButtonsDisabled(disabled) {
    for (const id of ['ytdl-dlvid', 'ytdl-dlmp3']) {
      const b = el(id);
      if (b) b.disabled = disabled;
    }
    const cancel = el('ytdl-cancel');
    if (cancel) cancel.disabled = !disabled;
  }

  function showProg(show) {
    const p = el('ytdl-prog');
    if (p) p.hidden = !show;
  }

  function onProgressUI(s) {
    if (!s) return;
    if (s.phase === 'download') {
      if (s.total > 0) {
        setFill(s.got / s.total);
        setStatus('Lade … ' + formatBytes(s.got) + ' von ' + formatBytes(s.total));
      } else {
        setFill(-1);
        setStatus('Lade … ' + formatBytes(s.got));
      }
    } else if (s.phase === 'encode') {
      setFill(-1);
      let text = 'MP3 wird encodiert … ' + formatTime(s.sec || 0);
      if (s.final) text = 'MP3-Fertigstellung …';
      setStatus(text);
    }
  }

  function togglePanel(forceOpen) {
    const panel = el('ytdl-panel');
    if (!panel) return;
    const shouldOpen = forceOpen === true ? true : panel.hidden;
    if (shouldOpen) {
      openPanel();
    } else {
      panel.hidden = true;
    }
  }

  function openPanel() {
    const panel = el('ytdl-panel');
    if (!panel) return;
    clearError();

    const info = getVideoInfo();
    if (!info) {
      showError('Keine Video-Informationen gefunden. Bitte auf einer YouTube-Videoseite öffnen.');
      panel.hidden = false;
      return;
    }

    el('ytdl-title').textContent = info.title;

    const sel = el('ytdl-q');
    sel.innerHTML = '';
    if (!info.qualities.length) {
      sel.innerHTML = '<option value="">– keine Streams verfügbar –</option>';
      sel.disabled = true;
      el('ytdl-dlvid').disabled = true;
    } else {
      sel.disabled = false;
      el('ytdl-dlvid').disabled = job.active;
      info.qualities.forEach((q, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = q.height + 'p' + (q.codec ? ' (' + q.codec + ')' : '');
        sel.appendChild(opt);
      });
      // Beste verfügbare Qualität vorauswählen
      sel.selectedIndex = 0;
    }
    el('ytdl-dlmp3').disabled = job.active;

    if (info.isLive) {
      showError('Live-Streams können nicht heruntergeladen werden.');
    } else if (!info.qualities.length && !info.progressiveAudio) {
      showError('Keine Streams für dieses Video verfügbar (möglicherweise Bot-Schutz oder Regionssperrung).');
    }
    panel.hidden = false;
  }

  /* =========================================================
   * Job-Steuerung
   * ========================================================= */

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function runJob(filename, run) {
    if (job.active) return;
    job = { active: true, cancel: false };
    const isCancelled = () => job.cancel;

    clearError();
    showProg(true);
    setFill(0);
    setStatus('Starte …');
    setButtonsDisabled(true);

    try {
      const blob = await run(onProgressUI, isCancelled);
      saveBlob(blob, filename);
      setFill(1);
      setStatus('Fertig: ' + filename + ' (' + formatBytes(blob.size) + ')');
    } catch (e) {
      if (e && e.name === 'AbortError') {
        setFill(0);
        setStatus('Abgebrochen.');
      } else {
        setFill(0);
        showError('Fehler: ' + ((e && e.message) || String(e)));
      }
    }
    job.active = false;
    setButtonsDisabled(false);
  }

  function startVideoDownload() {
    const info = getVideoInfo();
    if (!info) { showError('Keine Video-Informationen gefunden.'); return; }
    if (info.isLive) { showError('Live-Streams können nicht heruntergeladen werden.'); return; }
    if (!info.qualities.length) { showError('Keine Videostreams verfügbar.'); return; }

    const idx = parseInt(el('ytdl-q').value, 10) || 0;
    const q = info.qualities[idx];
    if (!q) { showError('Keine Qualität ausgewählt.'); return; }
    if (!q.progressive && !info.audio) {
      showError('Kein Audiostrom für das Merging verfügbar.');
      return;
    }

    const filename = sanitizeName(info.title) + '.mp4';
    runJob(filename, async (onProgress, isCancelled) => {
      if (q.progressive) {
        return downloadProgressive(q.url, onProgress, isCancelled);
      }
      return downloadMerged(q.url, info.audio.url, onProgress, isCancelled);
    });
  }

  function startMp3Download() {
    const info = getVideoInfo();
    if (!info) { showError('Keine Video-Informationen gefunden.'); return; }
    if (info.isLive) { showError('Live-Streams können nicht heruntergeladen werden.'); return; }
    if (!info.audio && !info.progressiveAudio) {
      showError('Kein Audiostrom verfügbar.');
      return;
    }

    const kbps = parseInt(el('ytdl-b').value, 10) || 192;
    const filename = sanitizeName(info.title) + '.mp3';
    runJob(filename, async (onProgress, isCancelled) => {
      if (info.audio) {
        return downloadMp3(info.audio.url, info.audio.codec, info.audio.sampleRate, kbps, onProgress, isCancelled);
      }
      // Nur progressiv: Audio aus der vollständigen MP4 ziehen
      // (moov am Dateiende -> Web-Audio-Fallback statt WebCodecs-Pfad)
      const prog = info.progressiveAudio;
      return mp3ViaDecodeAudioData(prog.url, kbps, onProgress, isCancelled);
    });
  }

  /* =========================================================
   * Initialisierung + SPA-Navigation beobachten
   * ========================================================= */

  let currentVideoId = null;

  function onDomChange() {
    const info = getVideoInfo();
    if (!info) return;

    const root = document.getElementById('ytdl-root');
    if (!root || !root.isConnected) {
      // Button nur zeigen, wenn tatsächlich ein Video geladen ist
      attachUI();
      currentVideoId = info.videoId;
      return;
    }

    // Bei SPA-Navigation (anderes Video) ggf. neu platzieren
    const host = document.querySelector('ytd-player-loaded') ||
      document.querySelector('#movie-container');
    if (host && host.parentElement &&
        root.parentElement !== host.parentElement &&
        root.classList.contains('ytdl-inline')) {
      host.parentElement.insertBefore(root, host.nextSibling);
    }

    // Offenes Panel bei Video-Wechsel aktuell halten
    if (info.videoId !== currentVideoId) {
      currentVideoId = info.videoId;
      const panel = el('ytdl-panel');
      if (panel && !panel.hidden) openPanel(true);
    }
  }

  const observer = new MutationObserver(onDomChange);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    // Attribut-Update des MAIN-Welt-Shims (neues Video / neue Formate)
    attributes: true,
    attributeFilter: ['data-ytdl']
  });

  // Erste Chance sofort nutzen (z. B. wenn die Seite bereits vollständig ist)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomChange, { once: true });
  }
  onDomChange();
  // Kurzes Nachhauen, falls der Player verzögert eingebunden wird
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    onDomChange();
    if (ticks > 30 || document.getElementById('ytdl-root')) clearInterval(timer);
  }, 1000);
  setTimeout(() => clearInterval(timer), 60000);
})();

/* mp4.js – ISO-BMFF (fMP4/DASH) Helfer
 *
 * Reinere Logik ohne DOM-Abhängigkeiten:
 *  - Box-Parser (ISO 14496-12)
 *  - Merging zweier DASH-Init-Segmente (Video + Audio) zu einem moov
 *  - Track-ID-Patching in moof/tfhd
 *  - Demuxing von Audio-Frames aus moof/mdat-Paaren (für die MP3-Kodierung)
 */
(() => {
  'use strict';

  /** Länge des Box-Headers (size + type). Kinder einer Container-Box beginnen danach. */
  const BODY = 8;

  function dvOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Iteriert über die Boxen eines Byte-Bereichs (eine Ebene). */
  function* boxIter(bytes, start, end) {
    let p = start;
    while (p + 8 <= end) {
      const dv = dvOf(bytes);
      let size = dv.getUint32(p);
      const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      let header = 8;
      if (size === 1) {
        if (p + 16 > end) {
          yield { type, off: p, size: end - p, truncated: true };
          return;
        }
        const hi = dv.getUint32(p + 8);
        const lo = dv.getUint32(p + 12);
        size = hi * 4294967296 + lo;
        header = 16;
      } else if (size === 0) {
        // "Box erstreckt sich bis zum Ende des Containers"
        size = end - p;
      }
      if (size < header || p + size > end) {
        yield { type, off: p, size: Math.max(end - p, header), truncated: true };
        return;
      }
      yield { type, off: p, size, truncated: false };
      p += size;
    }
  }

  function findBox(bytes, type, start, end) {
    if (start === undefined) { start = 0; end = bytes.length; }
    for (const b of boxIter(bytes, start, end)) {
      if (b.type === type) return b;
    }
    return null;
  }

  function findBoxes(bytes, type, start, end) {
    if (start === undefined) { start = 0; end = bytes.length; }
    const out = [];
    for (const b of boxIter(bytes, start, end)) {
      if (b.type === type) out.push(b);
    }
    return out;
  }

  /** Sucht ein Kind direkt innerhalb einer Container-Box (box = Ergebnis von findBox). */
  function findChild(bytes, type, box) {
    return findBox(bytes, type, box.off + BODY, box.off + box.size);
  }

  function raw(bytes, box) {
    return bytes.subarray(box.off, box.off + box.size);
  }

  /** Baut eine neue Box aus Typ und (mehreren) Payload-Bytefolgen. */
  function makeBox(type, ...parts) {
    let size = 8;
    for (const p of parts) size += p.length;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, size >>> 0);
    for (let i = 0; i < 4; i++) dv.setUint8(4 + i, type.charCodeAt(i));
    let p = 8;
    for (const part of parts) {
      out.set(part, p);
      p += part.length;
    }
    return out;
  }

  /* ---------- Track-IDs ---------- */

  /**
   * Offset des 4-Byte-Felds nach creation/modification-Time (abhängig von version).
   * Das ist die track_ID in tkhd und die timescale in mdhd.
   */
  function timeFieldOffset(box, dv) {
    const version = dv.getUint8(box.off + 8);
    return box.off + 12 + (version === 1 ? 16 : 8);
  }

  function trakTrackId(trak) {
    const tkhd = findBox(trak, 'tkhd', BODY, trak.length);
    if (!tkhd) throw new Error('tkhd-Box fehlt');
    const dv = dvOf(trak);
    return dv.getUint32(timeFieldOffset(tkhd, dv));
  }

  function setTrakTrackId(trak, newId) {
    const out = trak.slice();
    const tkhd = findBox(out, 'tkhd', BODY, out.length);
    if (!tkhd) throw new Error('tkhd-Box fehlt');
    const dv = dvOf(out);
    dv.setUint32(timeFieldOffset(tkhd, dv), newId);
    return out;
  }

  function setTrexTrackId(trex, newId) {
    const out = trex.slice();
    const dv = dvOf(out);
    dv.setUint32(12, newId);
    return out;
  }

  /* ---------- moof-Patching ---------- */

  /**
   * Setzt die Track-ID in allen traf/tfhd-Boxen einer moof um.
   *
   * moofPos ist die absolute Byte-Position der moof in der Ausgabedatei.
   * Hat die tfhd base-data-offset gesetzt (DASH-Standard), wird dieser auf
   * moofPos gesetzt, damit die trun-data_offsets in der neuen Datei stimmen.
   */
  function patchMoof(moof, newTrackId, moofPos) {
    const out = moof.slice();
    const dv = dvOf(out);
    for (const traf of findBoxes(out, 'traf', BODY, out.length)) {
      const tfhd = findChild(out, 'tfhd', traf);
      if (!tfhd) continue;
      dv.setUint32(tfhd.off + 12, newTrackId);
      const flags = dv.getUint32(tfhd.off + 8) & 0xffffff;
      if (flags & 0x000001) {
        // base-data-offset ist in tfhd immer 64 Bit
        dv.setBigUint64(tfhd.off + 16, BigInt(moofPos));
      }
    }
    return out;
  }

  /* ---------- Init-Segment-Auswertung ---------- */

  /** Timescale (z. B. 48000) aus mdhd des ersten Tracks. */
  function timescaleOf(init) {
    const moov = findBox(init, 'moov');
    if (!moov) return null;
    const trak = findChild(init, 'trak', moov);
    if (!trak) return null;
    const mdia = findChild(init, 'mdia', trak);
    if (!mdia) return null;
    const mdhd = findChild(init, 'mdhd', mdia);
    if (!mdhd) return null;
    const dv = dvOf(init);
    return dv.getUint32(timeFieldOffset(mdhd, dv));
  }

  /**
   * Merged die beiden Init-Segmente (jeweils ftyp+moov mit je einem Track)
   * zu einem einzigen moov mit zwei Tracks.
   * Das Video behält seine Track-ID, das Audio bekommt die andere.
   */
  function buildMergedMoov(vInit, aInit) {
    const vMoov = findBox(vInit, 'moov');
    const aMoov = findBox(aInit, 'moov');
    if (!vMoov || !aMoov) throw new Error('Init-Segment ohne moov-Box');

    const vmvhdBox = findChild(vInit, 'mvhd', vMoov);
    const vTrakBox = findChild(vInit, 'trak', vMoov);
    const aTrakBox = findChild(aInit, 'trak', aMoov);
    const vMvex = findChild(vInit, 'mvex', vMoov);
    const aMvex = findChild(aInit, 'mvex', aMoov);
    if (!vmvhdBox || !vTrakBox || !aTrakBox || !vMvex || !aMvex) {
      throw new Error('Ungültiges fragmentiertes MP4 (mvhd/trak/mvex fehlt)');
    }

    const vTrexBox = findChild(vInit, 'trex', vMvex);
    const aTrexBox = findChild(aInit, 'trex', aMvex);
    if (!vTrexBox || !aTrexBox) throw new Error('trex-Box fehlt');

    const mvhd = raw(vInit, vmvhdBox);
    const vTrak = raw(vInit, vTrakBox);
    const vTrex0 = raw(vInit, vTrexBox);
    const aTrex0 = raw(aInit, aTrexBox);
    let aTrak = raw(aInit, aTrakBox);

    const vId = trakTrackId(vTrak);
    const aId = vId === 1 ? 2 : 1;
    aTrak = setTrakTrackId(aTrak, aId);
    const mvexNew = makeBox('mvex', vTrex0, setTrexTrackId(aTrex0, aId));

    return {
      moov: makeBox('moov', mvhd, vTrak, aTrak, mvexNew),
      vId,
      aId
    };
  }

  function ftypOf(init) {
    const b = findBox(init, 'ftyp');
    if (b) return init.subarray(b.off, b.off + b.size);
    const out = new Uint8Array(16);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 16);
    out.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
    out.set([0x66, 0x6d, 0x70, 0x34], 8); // 'fmp4'
    dv.setUint32(12, 1);
    return out;
  }

  /* ---------- Audio-Demuxing ---------- */

  /**
   * Liest die einzelnen Audio-Frames (Rohdaten, z. B. Opus/AAC-Pakete)
   * aus einem moof+mdat-Paar eines fragmentierten MP4s.
   *
   * moof und mdat sind die vollständigen Box-Bytes (inkl. Header).
   * Rückgabe: [{ data, tsUs, durUs }, ...] in Sample-Reihenfolge.
   */
  function demuxAudioFrames(moof, mdat, timescale) {
    const dv = dvOf(moof);
    const traf = findChild(moof, 'traf', { off: 0, size: moof.length });
    if (!traf) throw new Error('traf-Box fehlt');

    // tfhd: Standard-Dauer/-Größe, falls die trun sie nicht pro Sample angibt
    let defDur = 0;
    let defSize = 0;
    const tfhd = findChild(moof, 'tfhd', traf);
    if (tfhd) {
      const flags = dv.getUint32(tfhd.off + 8) & 0xffffff;
      let p = tfhd.off + 16; // nach Header, version/flags und track_ID
      if (flags & 0x000001) p += 8; // base-data-offset
      if (flags & 0x000002) p += 4; // sample-description-index
      if (flags & 0x000008) { defDur = dv.getUint32(p); p += 4; }
      if (flags & 0x000010) { defSize = dv.getUint32(p); }
    }

    let baseTime = 0;
    const tfdt = findChild(moof, 'tfdt', traf);
    if (tfdt) {
      if (dv.getUint8(tfdt.off + 8) === 1) baseTime = Number(dv.getBigUint64(tfdt.off + 12));
      else baseTime = dv.getUint32(tfdt.off + 12);
    }

    const trun = findChild(moof, 'trun', traf);
    if (!trun) throw new Error('trun-Box fehlt');
    const flags = dv.getUint32(trun.off + 8) & 0xffffff;
    let p = trun.off + 12;
    const sampleCount = dv.getUint32(p);
    p += 4;

    // data_offset ist relativ zum Anfang der moof. Der mdat-Puffer beginnt
    // bei Index moof.length; die Nutzdaten beginnen bei Index 8 (nach dem
    // mdat-Header). Ohne data_offset gilt dasselbe für den ersten Sample.
    let cursor = 8;
    if (flags & 0x000001) {
      cursor = dv.getInt32(p) - moof.length;
      p += 4;
    }
    if (flags & 0x000004) p += 4; // first-sample-flags

    const frames = [];
    let mediaTime = 0;
    let lastDur = 0;

    for (let i = 0; i < sampleCount; i++) {
      let dur = defDur;
      let size = defSize;
      if (flags & 0x000100) { dur = dv.getUint32(p); p += 4; }   // sample-duration
      if (flags & 0x000200) { size = dv.getUint32(p); p += 4; }  // sample-size
      if (flags & 0x000400) { p += 4; }                          // sample-flags
      if (flags & 0x000800) { p += 4; }                          // composition-time-offset

      if (!size) throw new Error('Sample-Größe unbekannt (trun ohne Sample-Größen)');
      if (!dur) dur = lastDur || 1024;
      else lastDur = dur;

      if (cursor < 0 || cursor + size > mdat.byteLength) {
        throw new Error('Audio-Sample liegt außerhalb des mdat');
      }
      frames.push({
        data: mdat.subarray(cursor, cursor + size),
        tsUs: Math.round((baseTime + mediaTime) * 1e6 / timescale),
        durUs: Math.round(dur * 1e6 / timescale)
      });
      mediaTime += dur;
      cursor += size;
    }
    return frames;
  }

  /* ---------- DASH-Merge (Fragmente zusammensetzen) ---------- */

  /**
   * Setzt Video- und Audio-Fragmente zu einer fMP4-Datei zusammen.
   * Fragmente werden abwechselnd geschrieben (Video, Audio, Video, …);
   * ein Track darf auch länger sein, dann werden die Reste am Ende angehängt.
   *
   * Benutzung: addVideo()/addAudio() mit moof- und mdat-Box-Bytes, am Ende finish().
   */
  class DashMerger {
    constructor(vInit, aInit) {
      this.merged = buildMergedMoov(vInit, aInit);
      const ftyp = ftypOf(vInit);
      this.parts = [ftyp, this.merged.moov];
      // Schreibposition in der Ausgabe – tfhd base-data-offset zeigt darauf
      this.pos = ftyp.length + this.merged.moov.length;
      this.qv = [];
      this.qa = [];
    }

    addVideo(moof, mdat) {
      this.qv.push({ moof, mdat });
      this.flush();
    }

    addAudio(moof, mdat) {
      this.qa.push({ moof, mdat });
      this.flush();
    }

    /** Schreibt so lange Paare, wie beide Tracks Fragmente haben. */
    flush() {
      while (this.qv.length && this.qa.length) {
        this.write(this.qv.shift(), this.merged.vId);
        this.write(this.qa.shift(), this.merged.aId);
      }
    }

    write(frag, trackId) {
      const moof = patchMoof(frag.moof, trackId, this.pos);
      this.emit(moof, frag.mdat);
    }

    emit(...parts) {
      for (const p of parts) {
        this.parts.push(p);
        this.pos += p.length;
      }
    }

    /** Hängt Reste des längeren Tracks an und liefert alle Byte-Teile der Datei. */
    finish() {
      while (this.qv.length) this.write(this.qv.shift(), this.merged.vId);
      while (this.qa.length) this.write(this.qa.shift(), this.merged.aId);
      return this.parts;
    }
  }

  globalThis.MP4T = {
    boxIter,
    findBox,
    findBoxes,
    makeBox,
    trakTrackId,
    patchMoof,
    timescaleOf,
    buildMergedMoov,
    ftypOf,
    demuxAudioFrames,
    DashMerger
  };
})();

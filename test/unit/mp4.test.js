/* mp4.test.js – Unit-Tests für mp4.js (DASH-Merge und Audio-Demuxing)
 *
 * Ohne Browser lauffähig:  node --test test/unit/
 * Benötigt ffmpeg/ffprobe im PATH (sonst werden die Tests übersprungen).
 * Die Test-Streams liegen in test/fixtures/ (siehe make_fixtures.sh).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

require('../../mp4.js');
const M = globalThis.MP4T;

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function hasTool(name) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

const HAS_FFMPEG = hasTool('ffmpeg') && hasTool('ffprobe');
const skip = HAS_FFMPEG ? false : 'ffmpeg/ffprobe nicht installiert';

function load(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

/** Zerlegt eine fragmentierte MP4 in Init-Segment und moof/mdat-Paare. */
function split(file) {
  const moov = M.findBox(file, 'moov');
  const init = file.subarray(0, moov.off + moov.size);
  const frags = [];
  let p = moov.off + moov.size;
  for (;;) {
    const moof = M.findBox(file, 'moof', p, file.length);
    if (!moof) break;
    const mdat = M.boxIter(file, moof.off + moof.size, file.length).next().value;
    frags.push({
      moof: file.subarray(moof.off, moof.off + moof.size),
      mdat: file.subarray(mdat.off, mdat.off + mdat.size)
    });
    p = mdat.off + mdat.size;
  }
  return { init, frags };
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-test-'));
  return path.join(dir, name);
}

/** ffprobe: Anzahl der Pakete je Stream-Typ (video/audio). */
function countPackets(file, type) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-count_packets', '-select_streams', type === 'video' ? 'v:0' : 'a:0',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file
  ]).toString().trim();
  return Number(out);
}

/** ffmpeg dekodiert die Datei komplett; jede Ausgabe auf stderr ist ein Fehler. */
function decodesCleanly(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  return r.status === 0 && r.stderr.toString().trim() === '';
}

/* ---------- DASH-Merge ---------- */

for (const [video, audio] of [
  ['video-dash-1080.mp4', 'audio-aac.mp4'],
  ['video-dash-720.mp4', 'audio-opus.mp4']
]) {
  test(`DashMerger: ${video} + ${audio} ergibt eine dekodierbare MP4`, { skip }, () => {
    const v = split(load(video));
    const a = split(load(audio));
    const merger = new M.DashMerger(v.init, a.init);

    // Abwechselnd, wie im Stream-Betrieb; Reste werden in finish() angehängt
    const n = Math.max(v.frags.length, a.frags.length);
    for (let i = 0; i < n; i++) {
      if (v.frags[i]) merger.addVideo(v.frags[i].moof, v.frags[i].mdat);
      if (a.frags[i]) merger.addAudio(a.frags[i].moof, a.frags[i].mdat);
    }
    const out = concat(merger.finish());

    const file = tmpFile('merged.mp4');
    fs.writeFileSync(file, out);
    assert.ok(decodesCleanly(file), 'ffmpeg meldet Dekodierfehler');
    assert.equal(countPackets(file, 'video'), countPackets(path.join(FIXTURES, video), 'video'));
    assert.equal(countPackets(file, 'audio'), countPackets(path.join(FIXTURES, audio), 'audio'));
  });
}

test('patchMoof setzt base-data-offset auf die Ausgabeposition', () => {
  const v = split(load('video-dash-720.mp4'));
  const frag = v.frags[0];
  const pos = 123456;
  const patched = M.patchMoof(frag.moof, 7, pos);
  const traf = M.findBox(patched, 'traf', 8, patched.length);
  const tfhd = M.findBox(patched, 'tfhd', traf.off + 8, traf.off + traf.size);
  const dv = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
  assert.equal(dv.getUint32(tfhd.off + 12), 7, 'track_ID');
  assert.equal(dv.getBigUint64(tfhd.off + 16), BigInt(pos), 'base-data-offset');
});

/* ---------- Audio-Demuxing ---------- */

function ffprobePacketPositions(file) {
  const json = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_packets',
    '-show_entries', 'packet=pos,size', '-of', 'json', file
  ]).toString();
  return JSON.parse(json).packets.map((p) => ({ pos: Number(p.pos), size: Number(p.size) }));
}

for (const name of ['audio-aac.mp4', 'audio-opus.mp4']) {
  test(`demuxAudioFrames: Samples von ${name} stimmen byte-genau mit ffprobe überein`, { skip }, () => {
    const file = load(name);
    const ts = M.timescaleOf(split(file).init);
    const { frags } = split(file);
    const frames = frags.flatMap((f) => M.demuxAudioFrames(f.moof, f.mdat, ts));
    const packets = ffprobePacketPositions(path.join(FIXTURES, name));

    assert.equal(frames.length, packets.length, 'Anzahl Samples');
    frames.forEach((fr, i) => {
      const ref = file.subarray(packets[i].pos, packets[i].pos + packets[i].size);
      assert.deepEqual(fr.data, ref, `Sample ${i}`);
    });
  });
}

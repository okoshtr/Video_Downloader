#!/usr/bin/env python3
"""run_tests.py – E2E-Tests der YouTube-Downloader-Erweiterung.

Startet Firefox (headless) mit Marionette und der (getesteten) Erweiterung,
lädt eine Fake-YouTube-Seite (lokaler HTTP-Server mit echten ffmpeg-Streams)
und prüft:
  1. UI: Button unter dem Player, Panel, Qualitätsoptionen
  2. DASH-Merge (1080p Video-Track + AAC-Audio-Track -> MP4)
  3. MP3 aus AAC (WebCodecs-Pfad)
  4. MP3 aus Opus (neue Seite, Content-Script-Reinjection)
  5. Progressiver Download (480p, eine Datei)
  6. MP3-Fallback (nur progressive Formate -> Web Audio API)
  7. Abbruch eines Downloads

Marionette-Protokoll (Firefox 158):
  - rohes TCP, Framing "LAENGE:JSON" (Byte-Länge des JSON-Payloads)
  - Command:   [0, id, "WebDriver:...", {benannte Parameter}]
  - Response:  [1, id, error|null, {value: ...}]
  - Willkommensnachricht beim Verbinden: {"applicationType":..., "marionetteProtocol":3}
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import http.server
import socketserver

ROOT = os.path.dirname(os.path.abspath(__file__))
EXT_PROD = os.path.dirname(ROOT)
TEST_EXT = os.path.join(ROOT, "extension")
WORK = os.path.join(ROOT, "work")
PROFILE = os.path.join(WORK, "profile")
DOWNLOADS = os.path.join(WORK, "downloads")
HTTP_PORT = 8000
MARIO_PORT = 2828
EXT_ID = "yt-downloader@tobias.local"

PASS = 0
FAIL = 0


def log(msg):
    print(msg, flush=True)


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        log(f"  ✔ {name}")
    else:
        FAIL += 1
        log(f"  ✘ {name}" + (f"  [{detail}]" if detail else ""))


# ---------------------------------------------------------------- HTTP-Server

class Handler(http.server.SimpleHTTPRequestHandler):
    serve_dir = ROOT

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=self.serve_dir, **kw)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/slow/"):
            name = self.path[len("/slow/"):]
            fpath = os.path.join(self.serve_dir, "fixtures", name)
            if not os.path.isfile(fpath):
                self.send_error(404)
                return
            with open(fpath, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Type", "video/mp4")
            self.end_headers()
            try:
                chunk = 64 * 1024
                for i in range(0, len(data), chunk):
                    self.wfile.write(data[i:i + chunk])
                    self.wfile.flush()
                    time.sleep(0.4)  # ~160 KB/s
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return
        if self.path in ("/", "/fake.html"):
            fpath = os.path.join(self.serve_dir, "fake.html")
            with open(fpath, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()


def start_http_server():
    class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True

    srv = Server(("127.0.0.1", HTTP_PORT), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


# ---------------------------------------------------------------- Marionette

class MarionetteError(RuntimeError):
    def __init__(self, command, error):
        super().__init__(f"{command}: {error}")
        self.error = error


class Marionette:
    """Client für das Marionette-Protokoll (rohes TCP, "LAENGE:JSON"-Framing)."""

    def __init__(self, port=MARIO_PORT):
        self.port = port
        self._sock = None
        self._buf = b""
        self._id = 0

    def connect(self, timeout=30):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                self._sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
                break
            except OSError as e:
                last = e
                time.sleep(0.5)
        else:
            raise RuntimeError(f"Keine Marionette-Verbindung: {last}")
        self._sock.settimeout(120)
        self._welcome = self._read_packet()

    def _append(self):
        data = self._sock.recv(65536)
        if not data:
            raise ConnectionError("Marionette hat die Verbindung geschlossen")
        self._buf += data

    def _read_packet(self):
        # Header: Ziffern bis zum ersten ":"
        while True:
            idx = self._buf.find(b":")
            if idx != -1 and self._buf[:idx].isdigit():
                break
            if idx != -1 or len(self._buf) > 4096:
                raise RuntimeError(f"Ungültiges Marionette-Paket-Header: {self._buf[:60]!r}")
            self._append()
        n = int(self._buf[:idx])
        self._buf = self._buf[idx + 1:]
        while len(self._buf) < n:
            self._append()
        payload, self._buf = self._buf[:n], self._buf[n:]
        return json.loads(payload.decode("utf-8"))

    def command(self, name, params=None, timeout=120):
        self._id += 1
        mid = self._id
        payload = json.dumps([0, mid, name, params or {}]).encode("utf-8")
        frame = str(len(payload)).encode("ascii") + b":" + payload
        self._sock.settimeout(timeout)
        self._sock.sendall(frame)
        msg = self._read_packet()
        if not isinstance(msg, list) or len(msg) < 4 or msg[0] != 1:
            raise RuntimeError(f"Unerwartete Antwort auf {name}: {msg!r}")
        if msg[1] != mid:
            raise RuntimeError(f"Message-ID-Fehler bei {name}: {msg!r}")
        if msg[2] is not None:
            raise MarionetteError(name, msg[2])
        body = msg[3]
        if isinstance(body, dict) and set(body.keys()) == {"value"}:
            return body["value"]
        return body

    # -- bequeme Wrapper ------------------------------------------------

    def go(self, url):
        self.command("WebDriver:Navigate", {"url": url})

    def find(self, selector, timeout=25):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                el = self.command("WebDriver:FindElement",
                                 {"using": "css selector", "value": selector})
                if isinstance(el, str):
                    return el
                if isinstance(el, dict):
                    for k, v in el.items():
                        if k.startswith("element"):
                            return v
                return el
            except MarionetteError as e:
                last = e
                time.sleep(0.5)
        raise RuntimeError(f"Element nicht gefunden: {selector} ({last})")

    def click(self, element_id):
        self.command("WebDriver:ElementClick", {"id": element_id})

    def script(self, src, args=None, timeout=120):
        return self.command("WebDriver:ExecuteScript",
                            {"script": src, "args": args or []}, timeout=timeout)

    def quit(self):
        try:
            self.command("WebDriver:DeleteSession", {}, timeout=10)
        except Exception:
            pass
        try:
            self._sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------- Test-Setup

def make_test_extension():
    if os.path.exists(TEST_EXT):
        shutil.rmtree(TEST_EXT)
    shutil.copytree(EXT_PROD, TEST_EXT,
                    ignore=shutil.ignore_patterns("test", "work", "node_modules", ".git"))
    mpath = os.path.join(TEST_EXT, "manifest.json")
    with open(mpath) as f:
        man = json.load(f)
    # WICHTIG: Match-Patterns mit explizitem Port (":8000") matchen in
    # Firefox 158 NICHT (verifiziert: MatchPatternSet.matches() liefert
    # dafür false, auch für https/localhost). Nur der Port-freie Pattern
    # "http://127.0.0.1/*" matcht http://127.0.0.1:8000/...
    man["host_permissions"].append("http://127.0.0.1/*")
    for cs in man["content_scripts"]:
        cs["matches"].append("http://127.0.0.1/*")
    with open(mpath, "w") as f:
        json.dump(man, f, indent=2)
    return TEST_EXT


def make_profile():
    if os.path.exists(PROFILE):
        shutil.rmtree(PROFILE)
    os.makedirs(PROFILE, exist_ok=True)
    os.makedirs(DOWNLOADS, exist_ok=True)
    with open(os.path.join(PROFILE, "user.js"), "w") as f:
        f.write(
            'user_pref("xpinstall.signatures.required", false);\n'
            'user_pref("browser.download.dir", "%s");\n' % DOWNLOADS +
            'user_pref("browser.download.folderList", 2);\n'
            'user_pref("browser.helperApps.neverAsk.saveToDisk", "video/mp4;audio/mpeg;application/octet-stream");\n'
            'user_pref("browser.download.viewableInternally", false);\n'
            'user_pref("datareporting.policy.dataCollectionEnabled", false);\n'
            'user_pref("datareporting.healthreport.uploadEnabled", false);\n'
            'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);\n'
            'user_pref("browser.shell.checkDefaultBrowser", false);\n'
            'user_pref("app.update.enabled", false);\n'
            'user_pref("app.update.auto", false);\n'
            'user_pref("extensions.update.enabled", false);\n'
            'user_pref("browser.aboutwelcome.enabled", false);\n'
            'user_pref("privacy.popups.exception.0", "http://127.0.0.1:8000,allow");\n'
            # Firefox 158 "Origin Controls" (MV3): Host-Origin-Berechtigungen
            # werden beim Installieren NICHT automatisch erteilt. Mit diesem
            # Pref werden sie es (verifiziert in Extension.sys.mjs). Nur
            # für den Test nötig; produktiv aktivieren Nutzer die
            # Erweiterung pro Website per Klick auf das Aktions-Symbol.
            'user_pref("extensions.originControls.grantByDefault", true);\n'
        )
    # Hinweis: Die Erweiterung wird NICHT per extensions.ini geladen –
    # Release-Firefox lehnt unsignierte Add-ons dort ab. Stattdessen
    # installiert der Test sie zur Laufzeit als temporäres Add-on über
    # das Marionette-Command "Addon:Install" (kein Signing nötig).


def port_listening(port):
    """Prüft per /proc/net/tcp, ob ein Socket auf dem Port LISTENt
    (ohne eine TCP-Verbindung zu öffnen)."""
    hexport = format(port, "04X")
    for f in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(f) as fh:
                for line in fh.readlines()[1:]:
                    parts = line.split()
                    if len(parts) < 4:
                        continue
                    local, state = parts[1], parts[3]
                    if local.endswith(":" + hexport) and state == "0A":
                        return True
        except OSError:
            continue
    return False


def start_firefox():
    cmd = [
        "firefox",
        "-headless",
        "-no-remote",
        "-marionette",
        "-profile", PROFILE,
    ]
    env = dict(os.environ, MOZ_HEADLESS="1")
    log_file = os.path.join(WORK, "firefox.log")
    out = open(log_file, "wb")
    proc = subprocess.Popen(cmd, env=env,
                            stdout=out, stderr=subprocess.STDOUT)
    deadline = time.time() + 45
    while time.time() < deadline:
        if port_listening(MARIO_PORT):
            time.sleep(1.0)
            return proc
        if proc.poll() is not None:
            out.close()
            with open(log_file) as fh:
                log("\n--- Firefox-Log ---\n" + fh.read()[-4000:])
            raise RuntimeError("Firefox ist beim Start abgestürzt")
        time.sleep(0.5)
    raise RuntimeError("Marionette-Port wurde nicht erreichbar")


# ---------------------------------------------------------------- Verifikation

def clear_downloads():
    for f in os.listdir(DOWNLOADS):
        p = os.path.join(DOWNLOADS, f)
        if os.path.isfile(p):
            os.remove(p)


def wait_for_file(ext, timeout=120, m=None):
    deadline = time.time() + timeout
    while time.time() < deadline:
        cands = [f for f in os.listdir(DOWNLOADS) if f.endswith(ext)]
        if cands:
            p = os.path.join(DOWNLOADS, sorted(cands)[0])
            s1 = os.path.getsize(p)
            time.sleep(0.8)
            if os.path.getsize(p) == s1 and s1 > 0:
                return p
        time.sleep(0.3)
    detail = ""
    if m is not None:
        try:
            st = m.script("""
              const g = (id) => document.getElementById(id);
              return 'status=' + (g('ytdl-status') ? g('ytdl-status').textContent : '?')
                   + ' | error=' + (g('ytdl-error') ? g('ytdl-error').textContent : '?')
                   + ' | errorHidden=' + (g('ytdl-error') ? g('ytdl-error').hidden : '?');
            """)
            detail = f" [UI: {st}]"
        except Exception as e:
            detail = f" [UI-Abfrage fehlgeschlagen: {e}]"
    raise TimeoutError(f"Keine {ext}-Datei im Download-Ordner{detail}")


def ffprobe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", path],
        capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def decodes_clean(path, timeout=60):
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "null", "-"],
        capture_output=True, text=True, timeout=timeout)
    return r.returncode == 0 and len(r.stderr.strip()) == 0


def get_state(m):
    # Marionette erwartet den Funktions-Körper (kein function-Wrapper)
    return m.script("""
      const g = (id) => document.getElementById(id);
      const root = g('ytdl-root');
      const player = g('movie-container');
      const rr = root ? root.getBoundingClientRect() : null;
      const pr = player ? player.getBoundingClientRect() : null;
      const sel = g('ytdl-q');
      return {
        hasRoot: !!root,
        rootTop: rr ? rr.top : null,
        playerBottom: pr ? pr.bottom : null,
        panelHidden: g('ytdl-panel') ? g('ytdl-panel').hidden : null,
        title: g('ytdl-title') ? g('ytdl-title').textContent : null,
        options: sel ? Array.from(sel.options).map(o => o.textContent) : null,
        selValue: sel ? sel.value : null,
        status: g('ytdl-status') ? g('ytdl-status').textContent : null,
        error: g('ytdl-error') ? g('ytdl-error').textContent : null,
        errorHidden: g('ytdl-error') ? g('ytdl-error').hidden : null
      };
    """)


def open_panel(m):
    m.click(m.find("#ytdl-open"))
    time.sleep(0.5)


# ---------------------------------------------------------------- Tests

def test_ui(m):
    log("\n[1] UI")
    base = f"http://127.0.0.1:{HTTP_PORT}/fake.html"
    m.go(base)
    # UI erscheint asynchron (MAIN-Welt-Shim pollt, Content-Script tickt)
    for _ in range(40):
        if m.script("return !!document.getElementById('ytdl-root');"):
            break
        time.sleep(0.25)
    st = get_state(m)
    check("Download-Button vorhanden", st["hasRoot"])
    check("Button liegt unter dem Player",
          st["rootTop"] is not None and st["playerBottom"] is not None
          and st["rootTop"] >= st["playerBottom"] - 2,
          f"rootTop={st['rootTop']} playerBottom={st['playerBottom']}")
    open_panel(m)
    st = get_state(m)
    check("Panel geöffnet", st["panelHidden"] is False)
    check("Titel angezeigt", st["title"] == "Test Video Demo", str(st["title"]))
    check("Qualitätsoptionen (1080p, 720p, 480p)",
          st["options"] == ["1080p (H.264)", "720p (H.264)", "480p (H.264)"],
          str(st["options"]))


def test_dash_merge(m):
    log("\n[2] DASH-Merge 1080p + AAC -> MP4")
    clear_downloads()
    st = get_state(m)
    check("1080p vorausgewählt", st["selValue"] == "0", str(st["selValue"]))
    m.click(m.find("#ytdl-dlvid"))
    p = wait_for_file(".mp4", m=m)
    log(f"  -> {os.path.basename(p)} ({os.path.getsize(p)} Bytes)")
    info = ffprobe(p)
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    check("2 Spuren (Video + Audio)", v is not None and a is not None,
          json.dumps([s.get("codec_name") for s in streams]))
    check("Video H.264 1920x1080",
          v and v.get("codec_name") == "h264" and v.get("width") == 1920
          and v.get("height") == 1080, json.dumps(v or {}))
    check("Audio AAC 48 kHz",
          a and a.get("codec_name") == "aac" and a.get("sample_rate") == "48000",
          json.dumps(a or {}))
    dur = float(info.get("format", {}).get("duration", 0))
    check("Dauer ~8 s", 6.5 < dur < 10.5, f"{dur}")
    check("komplett dekodierbar", decodes_clean(p))


def test_mp3_aac(m):
    log("\n[3] MP3 aus AAC-Audio (WebCodecs)")
    clear_downloads()
    m.click(m.find("#ytdl-dlmp3"))
    p = wait_for_file(".mp3", m=m)
    log(f"  -> {os.path.basename(p)} ({os.path.getsize(p)} Bytes)")
    info = ffprobe(p)
    s = info.get("streams", [{}])[0]
    check("MP3-Stream", s.get("codec_name") == "mp3", json.dumps(s))
    dur = float(info.get("format", {}).get("duration", 0))
    check("Dauer ~8 s", 6.0 < dur < 12.0, f"{dur}")
    check("MP3 dekodierbar", decodes_clean(p))


def test_mp3_opus(m):
    log("\n[4] MP3 aus Opus-Audio (neue Seite)")
    clear_downloads()
    base = f"http://127.0.0.1:{HTTP_PORT}/fake.html?audio=opus"
    m.go(base)
    time.sleep(1.0)
    open_panel(m)
    m.click(m.find("#ytdl-dlmp3"))
    p = wait_for_file(".mp3", m=m)
    log(f"  -> {os.path.basename(p)} ({os.path.getsize(p)} Bytes)")
    info = ffprobe(p)
    s = info.get("streams", [{}])[0]
    check("MP3-Stream", s.get("codec_name") == "mp3", json.dumps(s))
    dur = float(info.get("format", {}).get("duration", 0))
    check("Dauer ~8 s", 6.0 < dur < 12.0, f"{dur}")
    check("MP3 dekodierbar", decodes_clean(p))


def test_progressive(m):
    log("\n[5] Progressiver Download 480p")
    clear_downloads()
    base = f"http://127.0.0.1:{HTTP_PORT}/fake.html"
    m.go(base)
    time.sleep(1.0)
    open_panel(m)
    m.script("document.getElementById('ytdl-q').value = '2';")
    m.click(m.find("#ytdl-dlvid"))
    p = wait_for_file(".mp4", m=m)
    log(f"  -> {os.path.basename(p)} ({os.path.getsize(p)} Bytes)")
    info = ffprobe(p)
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    check("2 Spuren (Video + Audio)", v is not None and a is not None)
    check("Video H.264 854x480",
          v and v.get("codec_name") == "h264" and v.get("width") == 854,
          json.dumps(v or {}))
    check("komplett dekodierbar", decodes_clean(p))


def test_mp3_fallback(m):
    log("\n[6] MP3-Fallback (nur progressive Formate, Web Audio API)")
    clear_downloads()
    base = f"http://127.0.0.1:{HTTP_PORT}/fake.html?noAdaptive=1"
    m.go(base)
    time.sleep(1.0)
    st = get_state(m)
    check("nur 480p in Auswahl", st["options"] == ["480p (H.264)"], str(st["options"]))
    m.click(m.find("#ytdl-dlmp3"))
    p = wait_for_file(".mp3", m=m)
    log(f"  -> {os.path.basename(p)} ({os.path.getsize(p)} Bytes)")
    info = ffprobe(p)
    s = info.get("streams", [{}])[0]
    check("MP3-Stream", s.get("codec_name") == "mp3", json.dumps(s))
    dur = float(info.get("format", {}).get("duration", 0))
    check("Dauer ~8 s", 6.0 < dur < 12.0, f"{dur}")
    check("MP3 dekodierbar", decodes_clean(p))


def test_cancel(m):
    log("\n[7] Abbruch eines Downloads")
    clear_downloads()
    base = f"http://127.0.0.1:{HTTP_PORT}/fake.html?slow=1"
    m.go(base)
    time.sleep(1.0)
    open_panel(m)
    m.script("document.getElementById('ytdl-q').value = '2';")
    m.click(m.find("#ytdl-dlvid"))
    time.sleep(2.5)
    st = get_state(m)
    check("Download läuft", st["status"] and "Lade" in st["status"], str(st["status"]))
    m.click(m.find("#ytdl-cancel"))
    deadline = time.time() + 15
    ok = False
    while time.time() < deadline:
        st = get_state(m)
        if st["status"] and "Abgebrochen" in st["status"]:
            ok = True
            break
        time.sleep(0.4)
    check("Status 'Abgebrochen'", ok, str(st["status"]))
    time.sleep(2.0)
    remaining = [f for f in os.listdir(DOWNLOADS) if not f.startswith(".")]
    check("keine (vollständige) Datei gespeichert",
          all(os.path.getsize(os.path.join(DOWNLOADS, f)) == 0 for f in remaining)
          or len(remaining) == 0,
          str(remaining))


def main():
    log("== Setup ==")
    if not os.path.isdir(os.path.join(ROOT, "fixtures")) or \
       not os.listdir(os.path.join(ROOT, "fixtures")):
        log("(Fixtures fehlen – erstelle sie…)")
        subprocess.run(["bash", os.path.join(ROOT, "make_fixtures.sh")], check=True)
    make_test_extension()
    make_profile()
    srv = start_http_server()
    log(f"HTTP-Server auf 127.0.0.1:{HTTP_PORT}")
    proc = start_firefox()
    log("Firefox gestartet")
    m = Marionette()
    try:
        m.connect()
        log(f"Marionette verbunden (Welcome: {m._welcome})")
        m.command("WebDriver:NewSession", {})
        log("Session erstellt")
        # Temporäres Add-on installieren (kein Signing nötig, wie bei
        # about:debugging; wird beim Beenden automatisch entfernt).
        m.command("Addon:Install", {"path": TEST_EXT, "temporary": True})
        log(f"Erweiterung installiert: {EXT_ID}")
        test_ui(m)
        test_dash_merge(m)
        test_mp3_aac(m)
        test_mp3_opus(m)
        test_progressive(m)
        test_mp3_fallback(m)
        test_cancel(m)
    finally:
        try:
            m.command("Addon:Uninstall", {"id": EXT_ID}, timeout=10)
        except Exception:
            pass  # temporäre Add-ons verschwinden ohnehin mit dem Prozess
        m.quit()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        srv.shutdown()
    log("\n== Ergebnis ==")
    log(f"{PASS} bestanden, {FAIL} fehlgeschlagen")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""diagnose.py – prüft, ob die JS-Dateien der Erweiterung gültig sind
und ob das Content-Script auf der Fake-Seite läuft."""
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_tests import (Marionette, MarionetteError, ROOT, TEST_EXT, WORK, PROFILE,
                       DOWNLOADS, HTTP_PORT, MARIO_PORT, EXT_ID,
                       Handler, start_http_server, make_test_extension,
                       make_profile, port_listening, start_firefox, log)


def main():
    if os.path.exists(WORK):
        shutil.rmtree(WORK)
    make_test_extension()
    make_profile()
    start_http_server()
    log(f"HTTP-Server auf 127.0.0.1:{HTTP_PORT}")
    proc = start_firefox()
    m = Marionette()
    try:
        m.connect()
        m.command("WebDriver:NewSession", {})
        m.command("Addon:Install", {"path": TEST_EXT, "temporary": True})
        log("Erweiterung installiert")
        m.go(f"http://127.0.0.1:{HTTP_PORT}/syntax_check.html")
        time.sleep(2.0)
        title = m.script("return document.title;")
        results = m.script("return document.getElementById('ytdl-results') ? document.getElementById('ytdl-results').textContent : '(kein Ergebnis-Div)';")
        log(f"title: {title}")
        log(f"Ergebnis: {results}")
        # Zusätzlich: läuft das Content-Script auf der echten Fake-Seite?
        m.go(f"http://127.0.0.1:{HTTP_PORT}/fake.html")
        time.sleep(2.0)
        has_root = m.script("return !!document.getElementById('ytdl-root');")
        log(f"fake.html -> ytdl-root vorhanden: {has_root}")
    finally:
        try:
            m.command("Addon:Uninstall", {"id": EXT_ID}, timeout=10)
        except Exception:
            pass
        m.quit()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()

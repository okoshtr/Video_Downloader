#!/usr/bin/env bash
# build.sh – erzeugt dist/youtube-downloader.xpi
#
# Die .xpi ist ein ZIP mit manifest.json direkt im Hauptverzeichnis.
# Nur die Dateien der Erweiterung werden aufgenommen (keine Tests, keine Doku).
set -euo pipefail
cd "$(dirname "$0")"

OUT=dist/youtube-downloader.xpi
mkdir -p dist
rm -f "$OUT"
zip -q -X -r "$OUT" manifest.json background.js content.js content.css mp4.js lib icons
unzip -tq "$OUT"
echo "Erstellt: $OUT"

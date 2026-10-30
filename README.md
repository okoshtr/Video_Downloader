# YouTube Downloader – Firefox-Erweiterung

Fügt auf YouTube-Videoseiten unter dem Player einen Button **„Herunterladen“** hinzu.
Damit lässt sich das Video als **MP4** (in gewählter Qualität) oder die Audiospur als **MP3** (128/192/320 kbps) speichern.
Alles läuft lokal im Browser – es gibt keinen externen Server.

## Funktionen

- **Video als MP4**
  - Progressive Formate (Video und Ton in einer Datei) werden direkt geladen.
  - Höhere Auflösungen liegen bei YouTube als getrennte Video- und Audiospuren (DASH) vor. Beide werden im Browser zu einer MP4 zusammengesetzt, ohne Neukodierung.
- **Audio als MP3**
  - Die Audiospur wird dekodiert (WebCodecs; Fallback über die Web Audio API) und mit [lamejs](https://github.com/zhuker/lamejs) zu MP3 kodiert.
- Fortschrittsanzeige, Abbrechen-Button und Fehlermeldungen im Panel.
- Erkennt SPA-Navigation (neues Video ohne Seitenneuladen).

Nicht unterstützt: Live-Streams, DRM-geschützte Inhalte und Videos, bei denen YouTube keine Streams ausliefert (z. B. Altersbeschränkung ohne Anmeldung).

## Installation

Voraussetzung: **Firefox 128 oder neuer** (die Erweiterung nutzt MAIN-World-Content-Scripts, ab Firefox 128 verfügbar).

### Temporär (zum Ausprobieren)

1. `about:debugging#/runtime/this-firefox` öffnen.
2. **„Temporäre Erweiterung laden“** wählen.
3. Die Datei `manifest.json` aus diesem Ordner auswählen.

Temporäre Erweiterungen werden beim Neustart von Firefox entfernt.

### Dauerhaft

Firefox akzeptiert dauerhaft nur signierte Erweiterungen. Entweder das Paket bei [addons.mozilla.org](https://addons.mozilla.org/developers/) als „Nur für mich“ signieren lassen oder in Firefox Developer Edition / Nightly `xpinstall.signatures.required` auf `false` setzen.

## Verwendung

1. Ein YouTube-Video öffnen.
2. Auf **„Herunterladen“** unter dem Player klicken.
3. Im Panel entweder die gewünschte Videoqualität unter *Video (MP4)* wählen und auf **„Video speichern“** klicken oder die Bitrate unter *Audio (MP3)* wählen und auf **„MP3 speichern“** klicken.

Der Download landet im normalen Download-Ordner von Firefox, benannt nach dem Videotitel.

## Aufbau

| Datei | Aufgabe |
| --- | --- |
| `manifest.json` | Manifest (Manifest V3), Berechtigungen, Content-Scripts |
| `lib/yt-extract.js` | Läuft in der Seiten-Welt (MAIN) und liest `ytInitialPlayerResponse` aus. Die Daten gehen über ein `<template>`-Element an das Content-Script. |
| `content.js` | UI, Qualitätsauswahl, Download-Logik (progressiv, DASH-Merge, MP3) |
| `mp4.js` | ISO-BMFF-Helfer: Box-Parser, DASH-Merge (`DashMerger`), Audio-Demuxing |
| `background.js` | Fetch-Proxy. Content-Scripts unterliegen der CORS-Policy der Seite, der Hintergrund-Prozess nicht. |
| `content.css` | Styling des Panels |
| `lib/lamejs.js` | MP3-Encoder (lamejs, vorkompiliert) |

## Tests

### Unit-Tests (Node.js, ohne Browser)

Prüfen den DASH-Merge und das Audio-Demuxing gegen echte Test-Streams. Benötigt `node` (≥ 18) sowie `ffmpeg` und `ffprobe` im PATH.

```bash
node --test test/unit/mp4.test.js
```

### End-to-End-Tests (Firefox)

`test/run_tests.py` startet Firefox headless mit Marionette, lädt die Erweiterung und eine Fake-YouTube-Seite (`test/fake.html`) und prüft UI, alle Download-Pfade und den Abbruch. Benötigt Firefox, `ffmpeg`/`ffprobe` und Python 3.

```bash
python3 test/run_tests.py
```

Die Test-Streams in `test/fixtures/` lassen sich mit `test/make_fixtures.sh` neu erzeugen. Die Icons mit `test/make_icons.py`.

Der E2E-Test kopiert die Erweiterung nach `test/extension/` und legt das Firefox-Profil unter `test/work/` an. Beides ist per `.gitignore` ausgeschlossen.

## Hinweis

Das Herunterladen von YouTube-Inhalten kann gegen die Nutzungsbedingungen von YouTube verstoßen. Die Erweiterung ist für den persönlichen Gebrauch mit Inhalten gedacht, deren Nutzung du verantworten kannst.

## Lizenz

Die Lizenz des Projekts ist noch nicht festgelegt.

Die mitgelieferte Bibliothek `lib/lamejs.js` (MP3-Encoder) stammt vom Upstream-Projekt lamejs, dessen Lizenz laut Projektseite LGPL-3.0 ist. Die Datei selbst enthält keinen Lizenztext; vor einer Veröffentlichung bitte prüfen.

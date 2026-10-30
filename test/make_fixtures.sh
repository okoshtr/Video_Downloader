#!/bin/bash
# Erzeugt Test-Streams:
#  - video-dash-720.mp4  : H.264 720p,  fragmentiertes MP4 (DASH-artig, Video-only)
#  - video-dash-1080.mp4 : H.264 1080p, fragmentiertes MP4 (DASH-artig, Video-only)
#  - audio-aac.mp4       : AAC 128k,    fragmentiertes MP4 (Audio-only)
#  - audio-opus.mp4      : Opus 64k,    fragmentiertes MP4 (Audio-only)
#  - progressive480.mp4  : normale MP4 mit Video (H.264 480p) + AAC
set -e
cd "$(dirname "$0")"
mkdir -p fixtures
cd fixtures
D=8

echo "== video-dash-720.mp4 =="
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=$D" \
  -c:v libx264 -profile:v main -pix_fmt yuv420p -g 90 \
  -movflags frag_keyframe+empty_moov -an video-dash-720.mp4

echo "== video-dash-1080.mp4 =="
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=$D" \
  -c:v libx264 -profile:v main -pix_fmt yuv420p -g 90 \
  -movflags frag_keyframe+empty_moov -an video-dash-1080.mp4

echo "== audio-aac.mp4 =="
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$D" \
  -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov audio-aac.mp4

echo "== audio-opus.mp4 =="
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$D" \
  -c:a libopus -b:a 64k -ar 48000 -movflags frag_keyframe+empty_moov audio-opus.mp4

echo "== progressive480.mp4 =="
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=854x480:rate=30:duration=$D" \
  -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=$D" \
  -c:v libx264 -profile:v main -pix_fmt yuv420p -c:a aac -b:a 128k -shortest progressive480.mp4

echo "== ffprobe-Prüfung =="
for f in video-dash-720.mp4 video-dash-1080.mp4 audio-aac.mp4 audio-opus.mp4 progressive480.mp4; do
  echo "--- $f"
  ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,sample_rate,channels -of default=noprint_wrappers=1 "$f"
done
echo "Fertig."

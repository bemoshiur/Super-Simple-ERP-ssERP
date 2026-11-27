#!/usr/bin/env bash
# npm run demo:gif: record the README walkthrough (e2e/demo-video.spec.ts, via scripts/e2e.sh: throwaway PostgreSQL + demo data)
# and encode docs/screenshots/demo.gif (<= 6 MB), docs/screenshots/demo.webm (<= 4 MB) and docs/screenshots/demo-poster.png.
#   DEMO_SKIP_RECORD=1   only re-encode the last recording in test-results/demo (no database, no build)
#   E2E_SKIP_BUILD=1     reuse the existing .next build (see scripts/e2e.sh)
# Needs ffmpeg (brew install ffmpeg / apt install ffmpeg) and the Playwright browser (npx playwright install chromium).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg is not installed. Install it (brew install ffmpeg / apt install ffmpeg) and run npm run demo:gif again." >&2
  exit 1
fi

OUT=docs/screenshots
REC=test-results/demo
GIF_MAX=$((6 * 1024 * 1024))
WEBM_MAX=$((4 * 1024 * 1024))

if [ "${DEMO_SKIP_RECORD:-0}" != 1 ]; then
  DEMO_VIDEO=1 bash scripts/e2e.sh e2e/demo-video.spec.ts
fi

SRC=$(ls -t "$REC"/*.webm 2>/dev/null | head -1 || true)
[ -n "$SRC" ] || { echo "ERROR: no recording found in $REC (the Playwright run failed?)." >&2; exit 1; }
TRIM=$(cat "$REC/trim-start.txt" 2>/dev/null || echo 0)
mkdir -p "$OUT"
size() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }

# GIF: shared palette, bayer dithering; step down fps / width / colours until it fits.
gif_done=0
for opt in "12 960 256" "12 960 192" "12 880 160" "10 800 128" "10 720 96"; do
  set -- $opt
  fps=$1 width=$2 colors=$3
  ffmpeg -v error -y -ss "$TRIM" -i "$SRC" \
    -vf "fps=$fps,scale=$width:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=$colors:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    -loop 0 "$OUT/demo.gif"
  s=$(size "$OUT/demo.gif")
  echo "demo.gif: fps=$fps width=$width colours=$colors -> $((s / 1024)) KB"
  if [ "$s" -le "$GIF_MAX" ]; then gif_done=1; break; fi
done
[ "$gif_done" = 1 ] || { echo "ERROR: could not get demo.gif under 6 MB." >&2; exit 1; }

# WebM (VP9, no audio).
webm_done=0
for crf in 34 38 42; do
  ffmpeg -v error -y -ss "$TRIM" -i "$SRC" -an -c:v libvpx-vp9 -crf "$crf" -b:v 0 -pix_fmt yuv420p -row-mt 1 -r 25 "$OUT/demo.webm"
  s=$(size "$OUT/demo.webm")
  echo "demo.webm: crf=$crf -> $((s / 1024)) KB"
  if [ "$s" -le "$WEBM_MAX" ]; then webm_done=1; break; fi
done
[ "$webm_done" = 1 ] || { echo "ERROR: could not get demo.webm under 4 MB." >&2; exit 1; }

# Poster: the dashboard at the start of the walkthrough.
ffmpeg -v error -y -ss "$(awk -v t="$TRIM" 'BEGIN{print t + 1.0}')" -i "$SRC" -frames:v 1 "$OUT/demo-poster.png"
echo "Wrote $OUT/demo.gif, $OUT/demo.webm, $OUT/demo-poster.png"

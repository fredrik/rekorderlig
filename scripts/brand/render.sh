#!/usr/bin/env bash
# Render the raster brand assets from the one drawn source, public/favicon.svg.
#
# The SVG is the icon; everything else in this list is a copy of it at a size
# something insists on, made here so nobody draws a thumb twice:
#
#   public/favicon.ico          16 and 32 px — browsers and link previewers ask
#                               for /favicon.ico unprompted, and a chat's card
#                               shows the .ico, not the SVG
#   public/apple-touch-icon.png 180 px, square — iOS rounds the corners itself,
#                               so the tile is laid on its own orange
#   public/og.png               1200×630, the card under a pasted link, from
#                               scripts/brand/og.html
#
# Rendered once and committed, not built in the Dockerfile: they change when
# the icon or the card changes, which is a design decision somebody makes, and
# the image build has no browser in it. Needs a Chromium (CHROME, or one of
# the usual names) and python3; nothing else.
#
# The icons are drawn onto a canvas *inside* the browser and read back as
# PNG, rather than screenshotted: headless Chromium will not paint a window
# smaller than about a hundred pixels, and a 16 px icon cut out of a bigger
# shot would need an image library on this side. The card is a plain
# screenshot, being 1200 px wide. The .ico is packed by hand — six bytes of
# header, a directory and the PNGs — which is shorter than a dependency; PNG
# entries in an .ico have been read by every browser since IE 11.
#
# Usage: scripts/brand/render.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
public="$(cd "$here/../../public" && pwd)"

chrome="${CHROME:-}"
if [[ -z $chrome ]]; then
  for candidate in google-chrome chromium chromium-browser \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if command -v "$candidate" >/dev/null 2>&1; then chrome="$candidate"; break; fi
  done
fi
if [[ -z $chrome ]]; then
  echo "no Chromium found; set CHROME=/path/to/chrome" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# `--virtual-time-budget` lets a page lay out, load its image and run its
# script before Chromium looks at it; without it the first paint is blank.
headless() {
  "$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --no-first-run --disable-dev-shm-usage --virtual-time-budget=3000 "$@" 2>/dev/null
}

# The card: one screenshot at its own size.
headless --window-size=1200,630 --screenshot="$public/og.png" "file://$here/og.html"

# The icons: the SVG, given a pixel size (drawImage needs one to scale from),
# inlined as a data URL — a file:// image would taint the canvas and
# toDataURL would refuse. Each size is drawn and read back as PNG; the page
# ends as one JSON object, which --dump-dom prints and python unpacks.
svg="$(sed 's|<svg |<svg width="64" height="64" |' "$public/favicon.svg" | base64 | tr -d '\n')"
cat > "$work/icons.html" <<HTML
<!doctype html><meta charset="utf-8"><body><script>
const img = new Image();
img.onload = () => {
  const out = {};
  for (const [size, background] of [[16, null], [32, null], [180, '#ff6600']]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, size, size); }
    ctx.drawImage(img, 0, 0, size, size);
    out[size] = c.toDataURL('image/png');
  }
  document.body.textContent = JSON.stringify(out);
};
img.src = 'data:image/svg+xml;base64,$svg';
</script></body>
HTML
headless --dump-dom "file://$work/icons.html" > "$work/icons.dom"

python3 - "$work/icons.dom" "$public" <<'PY'
import base64, json, re, struct, sys
dom, public = sys.argv[1:]
body = re.search(r'<body>(\{.*?\})</body>', open(dom).read(), re.S)
if not body:
    sys.exit('the icon page did not finish: no JSON in its body')
icons = {int(k): base64.b64decode(v.split(',', 1)[1]) for k, v in json.loads(body.group(1)).items()}
for size, png in icons.items():
    assert png[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', png[16:24]) == (size, size), size
open(f'{public}/apple-touch-icon.png', 'wb').write(icons[180])
entries = [icons[16], icons[32]]
offset = 6 + 16 * len(entries)
with open(f'{public}/favicon.ico', 'wb') as f:
    f.write(struct.pack('<HHH', 0, 1, len(entries)))
    for png in entries:
        w, h = struct.unpack('>II', png[16:24])
        f.write(struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(png), offset))
        offset += len(png)
    for png in entries:
        f.write(png)
PY

ls -l "$public/favicon.ico" "$public/apple-touch-icon.png" "$public/og.png"

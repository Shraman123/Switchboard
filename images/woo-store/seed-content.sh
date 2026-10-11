#!/usr/bin/env bash
# Populate an empty wp-content volume from the image (first boot only).
# Copies contents, never the mount point itself, so it works as non-root on
# volumes whose root directory belongs to root (e.g. local-path).
set -euo pipefail
dst=/var/www/html/wp-content
if [ ! -d "$dst/themes" ]; then
  echo "[seed] populating $dst"
  cp -r /usr/src/wordpress/wp-content/. "$dst/"
fi
mkdir -p "$dst/uploads"

#!/usr/bin/env bash
# Build the add-on into build/addon/ and package build/metareader.xpi.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf build/addon
npx tsc --noEmit -p ui
npx tsc --noEmit -p plugin
npx vite build --logLevel warn
npx esbuild plugin/index.ts --bundle --format=iife --global-name=MetaReader --target=firefox115 \
  --log-level=warning --outfile=build/addon/content/plugin.js
cp -r static/. build/addon/
rm -f build/metareader.xpi
(cd build/addon && zip -qr ../metareader.xpi .)
echo "built build/metareader.xpi"

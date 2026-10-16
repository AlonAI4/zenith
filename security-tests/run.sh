#!/bin/bash
# Re-run the saved checks. Usage: bash security-tests/run.sh
set -e
cd "$(dirname "$0")/.."
node security-tests/share-zip.mjs
node security-tests/packages.mjs
node security-tests/site-unlisted.mjs
zsh security-tests/update-preview.sh
node security-tests/app-update-attacks.mjs
node security-tests/camera-routes-attacks.mjs

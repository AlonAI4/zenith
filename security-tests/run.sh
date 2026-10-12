#!/bin/bash
# Re-run the saved checks. Usage: bash security-tests/run.sh
set -e
cd "$(dirname "$0")/.."
node security-tests/share-zip.mjs

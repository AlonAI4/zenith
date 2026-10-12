#!/bin/zsh
# Publishes the Zenith download page to Cloudflare Pages (project
# "zenith-download", https://zenith-download.pages.dev). It rebuilds the site
# first, and the build stops if the share zip fails the no-keys check.
set -e
cd "$(dirname "$0")"
./alon-site-build.sh
SITE="$PWD/.gev-cache/zenith-site"
# Run the publishing tool from an empty folder. Run inside this project, it
# rewrites the project's own files (package.json, vite.config.js and more).
cd "$(mktemp -d)"
npx --yes wrangler pages deploy "$SITE" --project-name zenith-download --branch main --commit-dirty=true

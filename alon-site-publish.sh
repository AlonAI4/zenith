#!/bin/zsh
# Publishes the Zenith download page to Cloudflare Pages (project
# "zenith-download", https://zenith-download.pages.dev). It rebuilds the site
# first. The Mac app itself is not on the site: it is on the GitHub Release,
# and ./alon-release.sh refuses to build it if a key is inside.
set -e
cd "$(dirname "$0")"
./alon-site-build.sh
SITE="$PWD/.gev-cache/zenith-site"
# Run the publishing tool from an empty folder. Run inside this project, it
# rewrites the project's own files (package.json, vite.config.js and more).
cd "$(mktemp -d)"
npx --yes wrangler pages deploy "$SITE" --project-name zenith-download --branch main --commit-dirty=true

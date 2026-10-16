#!/bin/zsh
# Builds a release of the Zenith Mac app, all on this Mac. It publishes NOTHING.
#   ./alon-release.sh            the public files (no keys anywhere in them)
#   ./alon-release.sh --private  also Alon's own copy with his keys inside
# Out: ~/Library/Caches/Zenith-release/<version>/out/ (outside the project, so
# the dev server can never hand these files, or Alon's keys, to a web page)
#   Zenith-mac.zip              a zip holding Zenith.dmg, which holds Zenith.app
#   Zenith-code-<version>.zip   the code only, for the app's own updates
#   update.json                 the update description, signed with the key in
#                               ~/.config/zenith/update-signing-key.pem
#   Zenith-Alon-private.zip     (--private) Alon's copy: never share it
# Then attach the first three to a GitHub Release named v<version> (only at
# good night, with Alon's yes and a parent's yes).
set -euo pipefail
cd "${0:A:h}"
ROOT="$PWD"
PRIVATE=0
[ "${1:-}" = "--private" ] && PRIVATE=1

KEY="$HOME/.config/zenith/update-signing-key.pem"
[ -f "$KEY" ] || { echo "No signing key at $KEY." >&2; exit 1; }
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit everything first: the release is built from the saved code only." >&2
  exit 1
fi
VERSION=$(node --input-type=module -e 'import { ZENITH_VERSION } from "./src/app/zenithVersion.js"; console.log(ZENITH_VERSION.number)')
# The oldest app that can take this code as an update. Raise it when the
# launcher, the Node inside the app or the update tool changes.
MIN_APP_VERSION="${MIN_APP_VERSION:-1.2}"
REPO_URL="https://github.com/AlonAI4/zenith"
RELEASES="$HOME/Library/Caches/Zenith-release"
mkdir -p "$RELEASES"
chmod 700 "$RELEASES"
REL="$RELEASES/$VERSION"
OUT="$REL/out"
rm -rf "$REL"
mkdir -p "$OUT" "$REL/work"
echo "Zenith $VERSION"

# 1. Node: the newest LTS that package.json accepts, checked against Node's own list of hashes.
DIST="$ROOT/.gev-cache/node-dist"
mkdir -p "$DIST"
NODE_VERSION="${NODE_VERSION:-$(curl -fsS https://nodejs.org/dist/index.json | node -e '
  let text = ""; process.stdin.on("data", (c) => (text += c)).on("end", () => {
    const ok = (v) => { const [a, b] = v.slice(1).split(".").map(Number); return (a === 24 && b >= 14) || a === 26; };
    console.log(JSON.parse(text).find((r) => r.lts && ok(r.version)).version);
  });')}"
TARBALL="node-$NODE_VERSION-darwin-arm64.tar.gz"
[ -f "$DIST/$TARBALL" ] || curl -fsS -o "$DIST/$TARBALL" "https://nodejs.org/dist/$NODE_VERSION/$TARBALL"
curl -fsS -o "$DIST/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
WANT=$(grep " $TARBALL\$" "$DIST/SHASUMS256-$NODE_VERSION.txt" | cut -d' ' -f1)
HAVE=$(shasum -a 256 "$DIST/$TARBALL" | cut -d' ' -f1)
[ -n "$WANT" ] && [ "$WANT" = "$HAVE" ] || { echo "Node download does not match nodejs.org's hash." >&2; exit 1; }
tar -xzf "$DIST/$TARBALL" -C "$REL/work"
NODE_SRC="$REL/work/node-$NODE_VERSION-darwin-arm64"
echo "Node $NODE_VERSION (hash checked)"

# 2. The code, from the saved alon branch, without my own tools.
./alon-share.sh "$REL/work/code.zip" > /dev/null
ditto -x -k "$REL/work/code.zip" "$REL/work/stage"
CODE="$REL/work/stage/Zenith"
echo "$VERSION" > "$CODE/.zenith-version"
LOCK_HASH=$(shasum -a 256 "$CODE/package-lock.json" | cut -d' ' -f1)
# The update pack: the code alone, no packages (the app reuses or installs them).
# No macOS extra data (._ files): the app's update check refuses anything outside Zenith/.
ditto -c -k --norsrc --noextattr --noacl --keepParent "$CODE" "$OUT/Zenith-code-$VERSION.zip"
if zipinfo -1 "$OUT/Zenith-code-$VERSION.zip" | grep -qv '^Zenith/'; then
  echo "The code pack holds files outside Zenith/." >&2
  exit 1
fi

# 3. The packages, installed with the Node that goes inside the app.
cp -cR "$CODE" "$REL/work/bundle-code"
(cd "$REL/work/bundle-code" && PUPPETEER_SKIP_DOWNLOAD=1 "$NODE_SRC/bin/node" \
  "$NODE_SRC/lib/node_modules/npm/bin/npm-cli.js" ci --no-audit --no-fund > "$REL/work/npm.log" 2>&1) ||
  { echo "Installing the packages failed: $REL/work/npm.log" >&2; exit 1; }
echo "Packages installed"

# 4. Zenith.app: the window, the launcher, Node, the code and the icon.
APP="$REL/work/Zenith.app"
osacompile -o "$APP" alon-app/Zenith.applescript
RES="$APP/Contents/Resources"
cp alon-app/launcher.sh "$RES/launcher.sh"
chmod +x "$RES/launcher.sh"
cp server/alon/appUpdate.mjs "$RES/appUpdate.mjs"
cp alon-app/update-public-key.pem "$RES/update-public-key.pem"
echo "$VERSION" > "$RES/version.txt"
mkdir -p "$RES/node/bin" "$RES/node/lib/node_modules"
cp "$NODE_SRC/bin/node" "$RES/node/bin/node"
cp -R "$NODE_SRC/lib/node_modules/npm" "$RES/node/lib/node_modules/npm"
cp "$NODE_SRC/LICENSE" "$RES/node/LICENSE"
echo "$NODE_VERSION" > "$RES/node/version.txt"
mv "$REL/work/bundle-code" "$RES/zenith"
ICONSET="$REL/work/Zenith.iconset"
mkdir -p "$ICONSET"
node alon-app/icon.mjs "$REL/work/icon-1024.png"
for size in 16 32 128 256 512; do
  sips -z $size $size "$REL/work/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" > /dev/null
  sips -z $((size * 2)) $((size * 2)) "$REL/work/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/applet.icns"
PLIST="$APP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "io.github.alonai4.zenith" "$PLIST"
plutil -replace CFBundleName -string "Zenith" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$VERSION" "$PLIST"
plutil -replace LSMinimumSystemVersion -string "13.0" "$PLIST"
# Apple silicon only: the Node and the packages inside are arm64.
plutil -replace LSArchitecturePriority -json '["arm64"]' "$PLIST"
plutil -replace NSHumanReadableCopyright -string "Zenith, built on God's Eye View by Bilawal Sidhu (MIT)." "$PLIST"
xattr -cr "$APP"

# The values in .env that are long enough to be keys, one per line.
key_values() {
  grep -E '^[A-Z0-9_]+=' "$ROOT/.env" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' | awk 'length($0) >= 12'
}

# No keys may go out: no .env, no value from .env, not the signing key.
check_no_keys() {
  local target="$1" value
  if find "$target" -name '.env' -not -path '*/node_modules/*' | grep -q .; then
    echo "A .env file is inside $target." >&2
    return 1
  fi
  if [ -f "$ROOT/.env" ] && grep -rqaF -f <(key_values) -- "$target"; then
    echo "A key value from .env is inside $target." >&2
    return 1
  fi
  local private_body
  private_body=$(grep -v -- '-----' "$KEY" | tr -d '\n')
  if grep -rqaF -- "$private_body" "$target"; then
    echo "The update signing key is inside $target." >&2
    return 1
  fi
}

package() { # package <app> <zip name>
  local app="$1" name="$2" dmgsrc="$REL/work/dmg-$2"
  # Signed last, the outer app only: Node keeps its own signature.
  codesign --force -s - "$app"
  rm -rf "$dmgsrc"
  mkdir -p "$dmgsrc"
  cp -cR "$app" "$dmgsrc/Zenith.app"
  ln -s /Applications "$dmgsrc/Applications"
  hdiutil create -volname Zenith -srcfolder "$dmgsrc" -format UDZO -ov "$REL/work/Zenith.dmg" > /dev/null 2>&1
  rm -f "$OUT/$name"
  (cd "$REL/work" && ditto -c -k --norsrc --noextattr --noacl Zenith.dmg "$OUT/$name")
}

if [ "$PRIVATE" = 1 ]; then
  [ -f "$ROOT/.env" ] || { echo "No .env to put in the private copy." >&2; exit 1; }
  cp -cR "$APP" "$REL/work/Zenith-private.app"
  cp "$ROOT/.env" "$REL/work/Zenith-private.app/Contents/Resources/alon-private.env"
  chmod 600 "$REL/work/Zenith-private.app/Contents/Resources/alon-private.env"
fi

check_no_keys "$CODE"
check_no_keys "$APP"
package "$APP" Zenith-mac.zip
# Check what really went out: open the finished disk image and look inside.
MNT="$REL/work/mnt"
mkdir -p "$MNT"
hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$REL/work/Zenith.dmg" > /dev/null
trap 'hdiutil detach "$MNT" > /dev/null 2>&1 || true' EXIT
check_no_keys "$MNT"
codesign --verify "$MNT/Zenith.app"
hdiutil detach "$MNT" > /dev/null
trap - EXIT
[ "$(zipinfo -1 "$OUT/Zenith-mac.zip")" = "Zenith.dmg" ] || { echo "Zenith-mac.zip should hold Zenith.dmg only." >&2; exit 1; }
echo "No keys in the public files"

# 5. The signed update description.
PACK="$OUT/Zenith-code-$VERSION.zip"
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { createHash } from "node:crypto";
  import { signManifest, checkManifest } from "./server/alon/appUpdate.mjs";
  const [pack, version, minApp, lockHash, url, key, publicKey, out] = process.argv.slice(1);
  const bytes = readFileSync(pack);
  const fields = { version, url, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, lockHash, minAppVersion: minApp };
  const manifest = { ...fields, signature: signManifest(fields, readFileSync(key, "utf8")) };
  if (!checkManifest(manifest, readFileSync(publicKey, "utf8")).ok) throw new Error("the signature does not check out");
  writeFileSync(out, JSON.stringify(manifest, null, 1) + "\n");
' "$PACK" "$VERSION" "$MIN_APP_VERSION" "$LOCK_HASH" \
  "$REPO_URL/releases/download/v$VERSION/Zenith-code-$VERSION.zip" "$KEY" alon-app/update-public-key.pem "$OUT/update.json"

if [ "$PRIVATE" = 1 ]; then
  package "$REL/work/Zenith-private.app" Zenith-Alon-private.zip
  chmod 600 "$OUT/Zenith-Alon-private.zip"
  # The working copy with the keys inside is not kept.
  rm -rf "$REL/work/Zenith-private.app" "$REL/work/dmg-Zenith-Alon-private.zip"
fi

size_of() { stat -f %z "$1" | awk '{ printf("%.0f MB", $1 / 1048576) }'; }
echo
echo "Built in $OUT (nothing was published):"
for file in "$OUT"/*; do echo "  $(basename "$file")  $(size_of "$file")"; done
echo "SHA-256 of Zenith-mac.zip: $(shasum -a 256 "$OUT/Zenith-mac.zip" | cut -d' ' -f1)"
[ "$PRIVATE" = 1 ] && echo "Zenith-Alon-private.zip has Alon's keys inside: never share it."
exit 0

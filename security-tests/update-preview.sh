#!/bin/zsh
# Re-test for F-004: the updater describes an update from the original
# project and installs nothing until it is told to, and then only the exact
# version it described. Run on a toy copy of "the original" and "our copy".
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
G() { git -c user.name=test -c user.email=test@example.invalid "$@"; }
failed=0
check() {
  if eval "$2"; then echo "✓ $1"; else echo "✗ $1"; failed=1; fi
}

# The "original project".
mkdir -p "$WORK/origin/src" "$WORK/origin/server" && cd "$WORK/origin" && git init -q -b main
printf '{"name":"toy","scripts":{"test":"echo ℹ tests 1; echo ℹ pass 1; echo ℹ fail 0"}}\n' > package.json
echo one > src/a.js && echo server > server/s.js
G add -A && G commit -q -m "start"

# "Our copy": a clone with an alon branch that holds the updater.
git clone -q "$WORK/origin" "$WORK/copy" && cd "$WORK/copy" && git switch -q -c alon
cp "$HERE/alon-update.sh" . && echo mine > src/mine.js
G add -A && G commit -q -m "our changes"

# The original moves on: page code, code that runs on the Mac, and an install step.
cd "$WORK/origin"
echo two > src/a.js && echo server2 > server/s.js
printf '{"name":"toy","scripts":{"test":"echo ℹ tests 1; echo ℹ pass 1; echo ℹ fail 0","postinstall":"touch POSTINSTALL_RAN"}}\n' > package.json
G add -A && G commit -q -m "Merge pull request #7 from someone/shiny" -m "Add the shiny layer"
cd "$WORK/copy"
main_before=$(git rev-parse main)
alon_before=$(git rev-parse alon)
untouched() {
  [ "$(git rev-parse main)" = "$main_before" ] && [ "$(git rev-parse alon)" = "$alon_before" ] &&
    [ "$(cat src/a.js)" = "one" ] && [ ! -e POSTINSTALL_RAN ] && [ "$(git branch --show-current)" = "alon" ]
}

preview="$(./alon-update.sh --preview 2>&1)"
id="$(print -r -- "$preview" | sed -n 's/^ID: //p')"
check "the preview names the change by its real title" 'print -r -- "$preview" | grep -q "Add the shiny layer"'
check "it warns about a step that runs by itself during install" 'print -r -- "$preview" | grep -q "WARNING: it adds or changes a step that runs by itself"'
check "it says some of the change runs on this Mac" 'print -r -- "$preview" | grep -q "runs on this Mac"'
check "it gives the ID of the version it described" '[ ${#id} -ge 7 ]'
check "describing an update installs nothing" untouched

./alon-update.sh --install 0000000 > /dev/null 2>&1
check "an ID that was not described is refused" '[ $? -ne 0 ] && untouched'

answer="$(printf 'no\n' | ./alon-update.sh 2>&1)"
check "answering anything but yes installs nothing" 'print -r -- "$answer" | grep -q "Not installed" && untouched'
answer="$(./alon-update.sh < /dev/null 2>&1)"
check "no answer at all installs nothing" 'print -r -- "$answer" | grep -q "Not installed" && untouched'

./alon-update.sh --install "$id" > "$WORK/install.log" 2>&1
check "the described version installs when told to" '[ "$(cat src/a.js)" = "two" ] && [ "$(git branch --show-current)" = "alon" ] && [ -e src/mine.js ]'
check "afterwards there is nothing new" './alon-update.sh --preview 2>&1 | grep -q "Nothing new"'

if [ $failed -ne 0 ]; then
  echo; echo "The updater installed something unasked, or did not describe it."; exit 1
fi
echo; echo "All update-preview checks passed."

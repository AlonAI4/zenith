#!/bin/zsh
# Saves a full copy of the SAVED Zenith work as one file in iCloud Drive: every
# commit on every branch, history included. It copies git's own storage, which
# never held .env (the API keys), node_modules or caches. Before a copy is kept
# it is restored into a temporary folder, compared with the alon branch, and
# searched for the key values in .env. The newest three copies are kept.
#   Usage:   ./alon-backup.sh
#   Restore: mkdir zenith && cd zenith && tar -xf <backup file> && git reset --hard alon
#            then put a .env file back and run npm install.
set -e
cd "$(dirname "$0")"
DEST="${ZENITH_BACKUP_DIR:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Zenith-backups}"
KEEP=3

if git ls-files --error-unmatch .env > /dev/null 2>&1; then
  echo "STOP: .env is saved in git, so a backup would carry the keys. Ask Claude."
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Note: unsaved changes are NOT in the backup. Only saved (committed) work is."
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FILE="zenith-backup-$(date +%Y-%m-%d-%H%M%S).tar"
tar -cf "$WORK/$FILE" .git

# Prove it: restore the copy and compare it with the alon branch.
mkdir "$WORK/restore"
tar -xf "$WORK/$FILE" -C "$WORK/restore"
git -C "$WORK/restore" reset -q --hard alon
want=$(git rev-parse alon)
got=$(git -C "$WORK/restore" rev-parse alon)
if [ "$want" != "$got" ] || [ -n "$(git -C "$WORK/restore" status --porcelain)" ] ||
  ! git -C "$WORK/restore" fsck --connectivity-only > /dev/null 2>&1; then
  echo "STOP: the copy did not restore to the same code. Nothing was kept."
  exit 1
fi

# Search every stored object, and git's other files, for the key values in .env.
if [ -f .env ]; then
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env | sed -E "s/^[^=]*=//; s/^[\"']//; s/[\"']\$//" |
    awk 'length($0) >= 16' > "$WORK/keys"
  if [ -s "$WORK/keys" ]; then
    in_objects=$(git -C "$WORK/restore" cat-file --batch-all-objects --batch |
      LC_ALL=C grep -a -c -F -f "$WORK/keys" || true)
    in_files=$(LC_ALL=C grep -r -a -l -F -f "$WORK/keys" "$WORK/restore/.git" --exclude-dir=objects |
      wc -l | tr -d ' ')
    if [ "$in_objects" != "0" ] || [ "$in_files" != "0" ] || [ -e "$WORK/restore/.env" ]; then
      echo "STOP: a key value is inside the copy. Nothing was kept. Ask Claude."
      exit 1
    fi
  fi
fi

mkdir -p "$DEST"
mv "$WORK/$FILE" "$DEST/$FILE"
ls -1 "$DEST"/zenith-backup-*.tar | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done
echo "Backed up to $DEST/$FILE ($(du -h "$DEST/$FILE" | cut -f1 | tr -d ' '))."
echo "It restores to the alon branch at $(git rev-parse --short alon) and holds no key values."
echo "Copies kept: $(ls -1 "$DEST"/zenith-backup-*.tar | wc -l | tr -d ' ')."

#!/bin/sh
set -e

# PUID/PGID handling so converted files end up owned by your QNAP user,
# not root. On QuTS Hero the 'admin' account is typically uid=1000,
# and the 'administrators' group is gid=0 (root). File Station will
# happily show files owned by that pair.

PUID="${PUID:-1000}"
PGID="${PGID:-0}"

# Create group if needed (skip if GID already exists, e.g. 0 = root)
if ! getent group "$PGID" >/dev/null 2>&1; then
    groupadd -g "$PGID" appgroup
fi

# Create user if needed
if ! id -u "$PUID" >/dev/null 2>&1; then
    useradd -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin appuser
fi

# Make sure output dir exists and is writable by our target UID
mkdir -p "${OUTPUT_DIR:-/media/converted}"
chown "$PUID:$PGID" "${OUTPUT_DIR:-/media/converted}" 2>/dev/null || true

echo "[mkvforge] Running as UID=$PUID GID=$PGID"
echo "[mkvforge] MEDIA_ROOT=${MEDIA_ROOT:-/media}"
echo "[mkvforge] OUTPUT_DIR=${OUTPUT_DIR:-/media/converted}"

exec gosu "$PUID:$PGID" "$@"

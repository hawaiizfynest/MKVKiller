#!/bin/sh
set -e

# If RUN_AS_ROOT=1, bypass PUID/PGID and run as root (needed for some NAS shares
# where ACLs prevent non-root users from deleting/renaming files).
if [ "${RUN_AS_ROOT:-0}" = "1" ]; then
    echo "[mkvforge] Running as root (RUN_AS_ROOT=1)"
    mkdir -p "${OUTPUT_DIR:-/media/converted}"
    echo "[mkvforge] MEDIA_ROOT=${MEDIA_ROOT:-/media}"
    echo "[mkvforge] OUTPUT_DIR=${OUTPUT_DIR:-/media/converted}"
    exec "$@"
fi

PUID="${PUID:-1000}"
PGID="${PGID:-0}"

if ! getent group "$PGID" >/dev/null 2>&1; then
    groupadd -g "$PGID" appgroup
fi
if ! id -u "$PUID" >/dev/null 2>&1; then
    useradd -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin appuser
fi

mkdir -p "${OUTPUT_DIR:-/media/converted}"
chown "$PUID:$PGID" "${OUTPUT_DIR:-/media/converted}" 2>/dev/null || true

echo "[mkvforge] Running as UID=$PUID GID=$PGID"
echo "[mkvforge] MEDIA_ROOT=${MEDIA_ROOT:-/media}"
echo "[mkvforge] OUTPUT_DIR=${OUTPUT_DIR:-/media/converted}"

exec gosu "$PUID:$PGID" "$@"

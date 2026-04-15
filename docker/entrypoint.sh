#!/bin/sh
set -e

if [ "${RUN_AS_ROOT:-0}" = "1" ]; then
    echo "[mkvforge] Running as root (RUN_AS_ROOT=1)"
    mkdir -p "${OUTPUT_DIR:-/media/converted}"
    mkdir -p "${DATA_DIR:-/data}"
    mkdir -p "${DATA_DIR:-/data}/scratch"
    echo "[mkvforge] MEDIA_ROOT=${MEDIA_ROOT:-/media}"
    echo "[mkvforge] OUTPUT_DIR=${OUTPUT_DIR:-/media/converted}"
    echo "[mkvforge] DATA_DIR=${DATA_DIR:-/data}"
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

mkdir -p "${DATA_DIR:-/data}"
mkdir -p "${DATA_DIR:-/data}/scratch"
chown -R "$PUID:$PGID" "${DATA_DIR:-/data}" 2>/dev/null || true

echo "[mkvforge] Running as UID=$PUID GID=$PGID"
echo "[mkvforge] MEDIA_ROOT=${MEDIA_ROOT:-/media}"
echo "[mkvforge] OUTPUT_DIR=${OUTPUT_DIR:-/media/converted}"
echo "[mkvforge] DATA_DIR=${DATA_DIR:-/data}"

exec gosu "$PUID:$PGID" "$@"

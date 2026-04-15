# MKVForge - MKV to MP4 converter with optional hardware encoding
FROM node:20-bookworm-slim AS build

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY server/package.json ./package.json
RUN npm install --omit=dev

# ---------- Runtime ----------
FROM node:20-bookworm-slim

# Enable contrib + non-free for intel-media-va-driver-non-free (amd64 only).
# Then install ffmpeg + base VA-API runtime on all archs, and Intel-specific
# drivers only on amd64 (they don't exist for arm64).
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
        sed -i 's/main$/main contrib non-free non-free-firmware/' /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates tini gosu \
        ffmpeg \
        libva2 libva-drm2; \
    ARCH="$(dpkg --print-architecture)"; \
    if [ "$ARCH" = "amd64" ]; then \
        apt-get install -y --no-install-recommends \
            vainfo \
            intel-media-va-driver-non-free \
            i965-va-driver; \
    else \
        echo "Skipping Intel VA-API drivers on $ARCH (not supported)"; \
    fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /build/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server ./server
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
ENV MEDIA_ROOT=/media
ENV OUTPUT_DIR=/media/converted
ENV DATA_DIR=/data
ENV MAX_CONCURRENT=1
ENV PUID=1000
ENV PGID=0
ENV LIBVA_DRIVER_NAME=iHD
ENV LIBVA_DRIVERS_PATH=/usr/lib/x86_64-linux-gnu/dri

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server/src/index.js"]

# MKVForge - MKV to MP4 converter
# Target: QNAP TS-h973AX (AMD Ryzen V1500B, QuTS Hero / ZFS), and other x86_64 NAS.
FROM node:20-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates tini gosu && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev

COPY server ./server
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
ENV MEDIA_ROOT=/media
ENV OUTPUT_DIR=/media/converted
ENV MAX_CONCURRENT=1
# Default matches QNAP 'admin' user / 'administrators' group on QuTS Hero.
ENV PUID=1000
ENV PGID=0

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server/src/index.js"]

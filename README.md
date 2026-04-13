# MKVForge

Self-hosted web app that converts H.265/H.264 MKV files to H.264 MP4, with full per-track control (video / audio / subtitles) and quality-preserving compression. Built and tested for the **QNAP TS-h973AX running QuTS Hero**, but works on any x86_64 Docker host.

## Features

- **Browse** your NAS media library in the browser — no uploads needed.
- **Per-track selection**: every video, audio, and subtitle track is listed with codec, language, channel layout, and default/forced flags. Check the ones you want to keep.
- **Quality-preserving compression** via `libx264` CRF mode. CRF 18–20 is visually lossless; lower = bigger file, higher = smaller. Presets from `ultrafast` → `veryslow` trade encode time for file size.
- **Subtitle handling**: keep as soft MP4 text (`mov_text`), burn into the video, or drop entirely.
- **Audio handling**: auto re-encode to AAC (MP4-safe), force AAC with custom bitrate, or stream copy when already compatible.
- **Optional downscale** to 2160p / 1080p / 720p / 480p.
- **Live job queue** with progress, fps, speed, ETA, and before/after file sizes via WebSocket.
- **PUID/PGID support** so converted files land owned by your QNAP user, not root.
- **Single Docker container**, multi-arch (amd64 + arm64).

## About the TS-h973AX

The TS-h973AX uses an **AMD Ryzen Embedded V1500B**. That chip is a capable 4-core / 8-thread Zen CPU, but it has **no integrated GPU**, so there is no VA-API / QuickSync hardware acceleration path available on this NAS — all encoding is software x264. In practice you can expect roughly:

- 1080p H.265 → H.264 at CRF 20 / preset `slow`: ~0.6–1.2× realtime
- 1080p H.265 → H.264 at CRF 20 / preset `medium`: ~1.2–2× realtime
- 4K H.265 → H.264: ~0.2–0.5× realtime (slow but works)

If you want faster encodes, bump the preset toward `medium` or `fast`. If you want smaller files, stay on `slow` or `slower`.

## Quick start on QuTS Hero

### Option A — Container Station, using prebuilt image from GHCR

Once your GitHub Actions build has published the image:

1. Container Station → **Applications** → **Create** → paste the contents of `docker-compose.yml`.
2. Change the `build: .` line to `image: ghcr.io/hawaiizfynest/mkvforge:latest`.
3. Edit the volume line to point at the share holding your MKVs — see path notes below.
4. Deploy, then open `http://<nas-ip>:8089`.

### Option B — Build locally on the NAS

1. SSH in, `git clone https://github.com/HawaiizFynest/mkvforge.git`.
2. `cd mkvforge && docker compose up -d --build` (or use `docker-compose` if that's what your QuTS Hero has).
3. Open `http://<nas-ip>:8089`.

### QuTS Hero volume paths

QuTS Hero is ZFS-based, so the raw paths look different from old QTS. Use the `/share/<ShareName>` symlink form — it resolves correctly regardless of pool layout:

| Form | Example | Notes |
|---|---|---|
| Symlink (recommended) | `/share/Multimedia` | Works on all QuTS Hero builds |
| Raw ZFS pool | `/share/ZFS530_DATA/Multimedia` | If symlink is missing; pool number varies |
| Legacy cache dev | `/share/CACHEDEV1_DATA/Multimedia` | Older/fallback path on some builds |

To confirm the correct path, SSH into the NAS and run `ls -la /share/` — you'll see the symlinks and their targets.

### PUID / PGID

By default the container runs as **UID 1000 / GID 0**, which matches QuTS Hero's `admin` user and `administrators` group. Files you convert will show up in File Station owned by `admin`, and anyone in the `administrators` group can read/delete them.

If you want a different owner, SSH in and check your user:

```bash
id your_user
# uid=1001(your_user) gid=100(everyone) groups=100(everyone),0(administrators)
```

Then set `PUID` and `PGID` in the compose file to match.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Internal port the server listens on |
| `MEDIA_ROOT` | `/media` | Root directory to browse inside the container |
| `OUTPUT_DIR` | `/media/converted` | Where converted MP4s are written |
| `MAX_CONCURRENT` | `1` | How many ffmpeg jobs run in parallel (keep at 1 on V1500B — ffmpeg already uses all 8 threads per job) |
| `PUID` | `1000` | UID files are written as |
| `PGID` | `0` | GID files are written as |
| `TZ` | — | Timezone (e.g. `America/Los_Angeles`) |

## GitHub Actions / GHCR

The workflow at `.github/workflows/docker.yml` builds a multi-arch (amd64 + arm64) image and pushes to `ghcr.io/hawaiizfynest/mkvforge` on every push to `main` and every `v*` tag. After the first successful build you can pull it on the NAS instead of building locally.

To tag a release, open the repo in GitHub Desktop, then **Repository → Open in Command Prompt** and:

```
git tag v1.0.0
git push origin v1.0.0
```

## Compression tips

- **CRF 18** — visually lossless, larger files. Archival.
- **CRF 20** (default) — near-transparent, sweet spot.
- **CRF 23** — solid streaming quality, noticeably smaller.
- Preset `slow` + CRF 20 is the best size/quality tradeoff for the V1500B.
- MP4 only supports a narrow set of subtitle formats. Soft-sub mode converts to `mov_text` which plays in most players. If the source has image-based subs (PGS / VobSub), use **burn-in** mode or drop them.

## License

MIT

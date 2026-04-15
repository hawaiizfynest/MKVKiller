# MKVKiller

[![Build](https://github.com/HawaiizFynest/mkvforge/actions/workflows/docker.yml/badge.svg)](https://github.com/HawaiizFynest/mkvforge/actions/workflows/docker.yml)
[![GHCR](https://img.shields.io/badge/ghcr.io-mkvforge-2b3137?logo=github)](https://github.com/HawaiizFynest/mkvforge/pkgs/container/mkvforge)
[![License: MIT](https://img.shields.io/badge/license-MIT-3ecf8e)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-amd64%20%7C%20arm64-blue)](https://github.com/HawaiizFynest/mkvforge/pkgs/container/mkvforge)
[![QNAP](https://img.shields.io/badge/QNAP-QuTS%20Hero-e1282d?logo=qnap&logoColor=white)](https://www.qnap.com/)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](https://docker.com)
[![ffmpeg](https://img.shields.io/badge/ffmpeg-powered-007808?logo=ffmpeg&logoColor=white)](https://ffmpeg.org)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Intel QSV](https://img.shields.io/badge/Intel-QuickSync-0071C5?logo=intel&logoColor=white)](https://www.intel.com/content/www/us/en/architecture-and-technology/quick-sync-video/quick-sync-video-general.html)
[![NVIDIA NVENC](https://img.shields.io/badge/NVIDIA-NVENC-76B900?logo=nvidia&logoColor=white)](https://developer.nvidia.com/nvidia-video-codec-sdk)

Self-hosted MKV/MP4 converter with per-track control, batch queue, resumable encoding, persistent conversion log, and **optional hardware encoding** (Intel QuickSync / NVIDIA NVENC). Built for QNAP NAS via Docker, runs anywhere Docker does.

## Features

- **Browse** your NAS media library directly in the browser — no uploads needed.
- **Per-track selection** — video, audio, and subtitle tracks listed with codec, language, channel layout, bitrate, and default/forced flags. Check the ones to keep.
- **Encoder choice** — software x264 (best quality), Intel QSV, or NVIDIA NVENC with auto-detection on startup.
- **Recommended settings** — context-aware presets based on source codec and resolution (Light / Balanced / Shrink hard / 1080p downscale).
- **Live size estimation** — see estimated output size and compression % before starting, updated in real time as you tweak settings.
- **Audio bitrate recommendations** — per-track bitrate display with recommended AAC bitrate based on channel count.
- **Batch queue** — checkbox files in the sidebar, configure shared settings, submit the entire batch at once. Per-file size estimates probe in parallel.
- **Resumable encoding** — encode in 10-minute segments. If the container restarts mid-conversion, it picks up where it left off automatically.
- **Persistent conversion log** — SQLite database survives container restarts. Full history with stats, searchable ffmpeg logs, and space-saved totals.
- **Replace original** — optionally delete the source file after successful conversion, moving the MP4 into the original's folder.
- **Color themes** — switch between Blue, Red, and Green accent colors via the theme dots in the header. Preference persists across sessions.
- **Sort by file size** — sort the file browser by name (default), largest first, or smallest first using the sort bar above the file list.
- **Single Docker container**, multi-arch (amd64 + arm64).

## Color Themes

Three color themes are available, switchable via the colored dots in the top-right corner of the header:

- **Blue** (default) — cool blue accents
- **Red** — red accents throughout the UI
- **Green** — green accents throughout the UI

Your theme choice is saved in the browser and persists across sessions.

## Sorting Files

The sidebar includes a sort bar with three options:

- **Name** — alphabetical (default, folders first)
- **Size ↓** — largest files first (useful for finding the biggest files to convert)
- **Size ↑** — smallest files first

Folders always sort to the top regardless of the file sort mode.

## Hardware Encoder Support

The container auto-detects available encoders on startup and shows indicator pills in the header (green = available):

| Encoder | When it works | Speed (1080p HEVC→H.264) | Quality vs file size |
|---|---|---|---|
| **CPU (x264)** | Always | 0.5–2× realtime | ✅ Best — smallest files at given quality |
| **Intel QSV** | Intel iGPU (Gen 8+) | 8–20× realtime | ~20% larger at same quality |
| **NVIDIA NVENC** | Turing+ GPU | 20–50× realtime | ~15% larger at same quality |

## Resumable Encoding

When enabled via the "Resumable encoding" checkbox:

1. The file is encoded in 10-minute segments stored in a scratch directory.
2. If the container stops mid-encode (reboot, crash, update), on next startup the server detects interrupted jobs and automatically resumes from the first incomplete segment.
3. After all segments finish, they're concatenated losslessly into the final MP4.
4. Scratch files are cleaned up after success.

**Note:** Subtitle tracks are dropped in resumable mode because segmented subtitle concat is fragile. Use non-resumable mode if you need soft subs.

## Conversion Log

The **Log** tab shows:

- **Stat cards** — total jobs, successful, failed, interrupted counts.
- **Space saved** — running total of bytes saved across all successful conversions.
- **Job history** — click any row to expand full details: source/output paths and sizes, encoder, timestamps, and the complete ffmpeg log with a search/filter bar.

Logs persist in a SQLite database inside the Docker volume — they survive container restarts, image updates, and NAS reboots.

## Deployment

### QNAP TS-h973AX (CPU only)

```yaml
services:
  mkvforge:
    image: ghcr.io/hawaiizfynest/mkvforge:latest
    container_name: mkvforge
    restart: unless-stopped
    ports:
      - "8089:8080"
    environment:
      - MEDIA_ROOT=/media
      - OUTPUT_DIR=/media/converted
      - DATA_DIR=/data
      - MAX_CONCURRENT=1
      - PUID=1000
      - PGID=0
      - RUN_AS_ROOT=1
      - TZ=America/Denver
    volumes:
      - /share/Multimedia:/media
      - mkvforge_data:/data

volumes:
  mkvforge_data:
```

### Intel Host with QuickSync

Add device passthrough for the iGPU:

```yaml
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "video"
      - "render"
```

### NVIDIA Host

Install nvidia-container-toolkit on the host, then:

```yaml
    runtime: nvidia
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=video,compute,utility
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Internal port |
| `MEDIA_ROOT` | `/media` | Browse root inside container |
| `OUTPUT_DIR` | `/media/converted` | Where converted MP4s land |
| `DATA_DIR` | `/data` | SQLite database and segment scratch space |
| `MAX_CONCURRENT` | `1` | Parallel ffmpeg jobs |
| `PUID` / `PGID` | `1000` / `0` | File ownership |
| `RUN_AS_ROOT` | `0` | Set to `1` to bypass PUID/PGID and run as root |
| `SEGMENT_LENGTH` | `600` | Resumable segment duration in seconds (default 10 min) |
| `LIBVA_DRIVER_NAME` | `iHD` | Intel media driver (`i965` for Gen 7 and older) |

## Quality Settings

- **CPU mode (CRF):** 18–20 = visually lossless, 23 = streaming, 26+ = small files
- **HW mode (CQ):** 20 = high, 23 = balanced, 28 = small files

## License

MIT

# MKVForge

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

Self-hosted MKV/MP4 converter with per-track control, batch queue, and **optional hardware encoding** (Intel QuickSync / NVIDIA NVENC). Built for QNAP NAS via Docker, but runs anywhere Docker does.

## Features

- Browse NAS media library in the browser, no uploads.
- Per-track selection: video / audio / subtitle, with codec, language, channels, bitrate.
- **Encoder choice**: software x264 (best quality), Intel QSV, or NVIDIA NVENC.
- Quality-preserving compression with CRF/CQ control and content-aware presets.
- Live size estimation before you start.
- Batch queue with per-file estimates that update with settings.
- Optional "Replace original" to delete the source after a successful conversion.
- Auto-detect available encoders on startup; UI hides options the host can't run.
- Single Docker container, multi-arch (amd64 + arm64).

## Hardware encoder support

The container auto-detects what's available on startup and shows pills in the header:

| Encoder | When it works | Speed (typical 1080p HEVC→H.264) | Quality vs file size |
|---|---|---|---|
| **CPU (x264)** | Always | 0.5–2× realtime depending on CPU | ✅ Best — smallest files at given quality |
| **Intel QSV** | Intel host with iGPU (Gen 8+) | 8–20× realtime | Larger files (~20%) at given quality |
| **NVIDIA NVENC** | Host with Turing+ NVIDIA GPU | 20–50× realtime | Larger files (~15%) at given quality |

**Important**: hardware encoders trade compression efficiency for speed. If your goal is *maximum file shrinkage*, use CPU. If your goal is *maximum throughput*, use HW.

## Deployment scenarios

### Scenario A — QNAP TS-h973AX (CPU only)

The TS-h973AX has no iGPU and no PCIe slot for a discrete GPU. CPU encoding is the only path. Use the default `docker-compose.yml`:

```yaml
volumes:
  - /share/Multimedia:/media
```

### Scenario B — Intel mini PC with QuickSync (recommended for speed)

A used Lenovo ThinkCentre M720q/M920q (i5-8500T or newer), Intel NUC, or any 8th-gen+ Intel system with iGPU. Mount the NAS share via NFS/CIFS, then enable `/dev/dri`:

```yaml
volumes:
  - /mnt/nas/Multimedia:/media
devices:
  - /dev/dri:/dev/dri
group_add:
  - "video"
  - "render"
```

Verify QSV inside the container after starting:

```bash
docker exec mkvforge vainfo
```

### Scenario C — Host with NVIDIA GPU

Install [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) on the host first. Then enable the runtime:

```yaml
runtime: nvidia
environment:
  - NVIDIA_VISIBLE_DEVICES=all
  - NVIDIA_DRIVER_CAPABILITIES=video,compute,utility
```

## Quality settings

- **CPU mode** uses CRF (lower = bigger/better):
  - 18–20: visually lossless, archival
  - 23: streaming quality, good shrink
  - 26+: small files, noticeable artifacts
- **HW mode** uses CQ/global_quality:
  - 20: high quality
  - 23: balanced (default)
  - 28: small files

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Internal port |
| `MEDIA_ROOT` | `/media` | Browse root inside container |
| `OUTPUT_DIR` | `/media/converted` | Where converted MP4s land |
| `MAX_CONCURRENT` | `1` | Parallel jobs |
| `PUID` / `PGID` | `1000` / `0` | File ownership (QNAP admin defaults) |
| `LIBVA_DRIVER_NAME` | `iHD` | Intel media driver (use `i965` for Gen 7 and older) |

## License

MIT

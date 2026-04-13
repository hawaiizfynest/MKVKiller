// MKVForge server - MKV -> MP4 converter with per-track control
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const http = require('http');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');

const PORT = parseInt(process.env.PORT || '8080', 10);
const MEDIA_ROOT = process.env.MEDIA_ROOT || '/media';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(MEDIA_ROOT, 'converted');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '1', 10);

// Ensure output dir exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// ---- Safe path resolution (prevent escaping MEDIA_ROOT) ----
function safeResolve(relPath) {
  const abs = path.resolve(MEDIA_ROOT, relPath || '.');
  const rootReal = fs.realpathSync(MEDIA_ROOT);
  if (!abs.startsWith(rootReal) && !abs.startsWith(MEDIA_ROOT)) {
    throw new Error('Path escapes MEDIA_ROOT');
  }
  return abs;
}

// ---- Browse files ----
app.get('/api/browse', async (req, res) => {
  try {
    const rel = req.query.path || '';
    const abs = safeResolve(rel);
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(abs, e.name);
      let size = 0;
      try { if (e.isFile()) size = (await fsp.stat(full)).size; } catch {}
      items.push({
        name: e.name,
        dir: e.isDirectory(),
        size,
        path: path.relative(MEDIA_ROOT, full)
      });
    }
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    res.json({ cwd: path.relative(MEDIA_ROOT, abs) || '', items });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Probe an MKV (or any media file) ----
app.get('/api/probe', (req, res) => {
  try {
    const abs = safeResolve(req.query.path);
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      abs
    ]);
    let out = '', err = '';
    ff.stdout.on('data', d => out += d);
    ff.stderr.on('data', d => err += d);
    ff.on('close', code => {
      if (code !== 0) return res.status(500).json({ error: err || 'ffprobe failed' });
      try {
        const data = JSON.parse(out);
        const streams = (data.streams || []).map(s => ({
          index: s.index,
          codec_type: s.codec_type,
          codec_name: s.codec_name,
          language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || 'und',
          title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
          channels: s.channels,
          channel_layout: s.channel_layout,
          width: s.width,
          height: s.height,
          bit_rate: s.bit_rate,
          default: s.disposition && s.disposition.default ? 1 : 0,
          forced: s.disposition && s.disposition.forced ? 1 : 0
        }));
        res.json({
          format: {
            duration: parseFloat(data.format.duration || 0),
            size: parseInt(data.format.size || 0, 10),
            bit_rate: parseInt(data.format.bit_rate || 0, 10),
            format_name: data.format.format_name
          },
          streams
        });
      } catch (e) {
        res.status(500).json({ error: 'parse failed: ' + e.message });
      }
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Job Queue ----
const jobs = new Map(); // id -> job
let running = 0;
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function publicJob(j) {
  return {
    id: j.id,
    input: j.input,
    output: j.output,
    status: j.status,
    progress: j.progress,
    fps: j.fps,
    speed: j.speed,
    eta: j.eta,
    error: j.error,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    inputSize: j.inputSize,
    outputSize: j.outputSize
  };
}

app.get('/api/jobs', (req, res) => {
  res.json([...jobs.values()].map(publicJob).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)));
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  if (j.status === 'running' && j.proc) {
    j.cancelled = true;
    j.proc.kill('SIGTERM');
    res.json({ ok: true });
  } else if (j.status === 'queued') {
    j.status = 'cancelled';
    res.json({ ok: true });
    broadcast({ type: 'job', job: publicJob(j) });
  } else {
    res.status(400).json({ error: 'cannot cancel in state ' + j.status });
  }
});

app.delete('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  if (j.status === 'running') return res.status(400).json({ error: 'running' });
  jobs.delete(req.params.id);
  res.json({ ok: true });
  broadcast({ type: 'removed', id: req.params.id });
});

// ---- Submit a conversion job ----
app.post('/api/convert', async (req, res) => {
  try {
    const {
      inputPath,
      selectedStreams,   // array of stream indices to keep
      crf = 20,
      preset = 'slow',
      videoCodec = 'libx264',
      audioMode = 'auto', // 'auto' | 'aac' | 'copy'
      audioBitrate = '192k',
      subtitleMode = 'soft', // 'soft' (mov_text) | 'burn' | 'none'
      burnSubIndex = null,
      maxHeight = null, // e.g. 1080 to downscale
      outputName = null
    } = req.body || {};

    if (!inputPath) return res.status(400).json({ error: 'inputPath required' });
    const absIn = safeResolve(inputPath);
    await fsp.access(absIn, fs.constants.R_OK);
    const stat = await fsp.stat(absIn);

    const base = outputName || path.basename(absIn, path.extname(absIn)) + '.mp4';
    const safeBase = base.replace(/[/\\]/g, '_');
    const absOut = path.join(OUTPUT_DIR, safeBase);

    const id = nanoid(10);
    const job = {
      id,
      input: absIn,
      inputRel: path.relative(MEDIA_ROOT, absIn),
      output: absOut,
      outputRel: path.relative(MEDIA_ROOT, absOut),
      inputSize: stat.size,
      outputSize: 0,
      status: 'queued',
      progress: 0,
      opts: { selectedStreams, crf, preset, videoCodec, audioMode, audioBitrate, subtitleMode, burnSubIndex, maxHeight },
      log: [],
      createdAt: Date.now()
    };
    jobs.set(id, job);
    broadcast({ type: 'job', job: publicJob(job) });
    res.json({ id });
    pump();
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function pump() {
  if (running >= MAX_CONCURRENT) return;
  const next = [...jobs.values()].find(j => j.status === 'queued');
  if (!next) return;
  runJob(next);
}

async function runJob(job) {
  running++;
  job.status = 'running';
  job.startedAt = Date.now();
  broadcast({ type: 'job', job: publicJob(job) });

  // Get duration for progress
  let duration = 0;
  try {
    const probeData = await probeFile(job.input);
    duration = probeData.format.duration || 0;
  } catch {}

  const args = buildFfmpegArgs(job, duration);
  job.log.push('ffmpeg ' + args.join(' '));

  const proc = spawn('ffmpeg', args);
  job.proc = proc;

  proc.stderr.on('data', chunk => {
    const s = chunk.toString();
    // parse progress
    const tm = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (tm && duration > 0) {
      const sec = (+tm[1]) * 3600 + (+tm[2]) * 60 + parseFloat(tm[3]);
      job.progress = Math.min(100, (sec / duration) * 100);
    }
    const fpsM = s.match(/fps=\s*([\d.]+)/);
    if (fpsM) job.fps = parseFloat(fpsM[1]);
    const spM = s.match(/speed=\s*([\d.]+)x/);
    if (spM) job.speed = parseFloat(spM[1]);
    if (job.speed && duration > 0) {
      const remain = duration * (1 - job.progress / 100);
      job.eta = Math.round(remain / job.speed);
    }
    job.log.push(s);
    if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
    broadcast({ type: 'progress', id: job.id, progress: job.progress, fps: job.fps, speed: job.speed, eta: job.eta });
  });

  proc.on('error', err => {
    job.status = 'error';
    job.error = err.message;
    finishJob(job);
  });

  proc.on('close', async code => {
    if (job.cancelled) {
      job.status = 'cancelled';
      try { await fsp.unlink(job.output); } catch {}
    } else if (code === 0) {
      job.status = 'done';
      job.progress = 100;
      try { job.outputSize = (await fsp.stat(job.output)).size; } catch {}
    } else {
      job.status = 'error';
      job.error = 'ffmpeg exited ' + code;
    }
    finishJob(job);
  });
}

function finishJob(job) {
  job.finishedAt = Date.now();
  job.proc = null;
  running--;
  broadcast({ type: 'job', job: publicJob(job) });
  pump();
}

function probeFile(abs) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs]);
    let out = '';
    ff.stdout.on('data', d => out += d);
    ff.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function buildFfmpegArgs(job, duration) {
  const o = job.opts;
  const selected = new Set(o.selectedStreams || []);
  const args = ['-hide_banner', '-y', '-i', job.input];

  // Map selected streams - we'll split by type to control codecs
  const videoIdx = [...selected].filter(i => streamTypeCache.get(job.input + ':' + i) === 'video');
  // We don't have the cache yet; safer to let user pass types. Use generic mapping:
  for (const i of selected) args.push('-map', `0:${i}`);

  // Video
  args.push('-c:v', o.videoCodec || 'libx264');
  args.push('-preset', o.preset || 'slow');
  args.push('-crf', String(o.crf ?? 20));
  args.push('-pix_fmt', 'yuv420p');
  args.push('-profile:v', 'high');
  args.push('-level', '4.1');

  // Scale filter if requested, or burn-in subtitles
  const vf = [];
  if (o.maxHeight) vf.push(`scale=-2:'min(${parseInt(o.maxHeight, 10)},ih)'`);
  if (o.subtitleMode === 'burn' && o.burnSubIndex != null) {
    // ffmpeg subtitles filter needs escaped path and stream index
    const escaped = job.input.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    vf.push(`subtitles='${escaped}':si=${o.burnSubIndex}`);
  }
  if (vf.length) args.push('-vf', vf.join(','));

  // Audio
  if (o.audioMode === 'copy') {
    args.push('-c:a', 'copy');
  } else if (o.audioMode === 'aac') {
    args.push('-c:a', 'aac', '-b:a', o.audioBitrate || '192k');
  } else {
    // auto: transcode to AAC (MP4-safe). Using aac for compatibility.
    args.push('-c:a', 'aac', '-b:a', o.audioBitrate || '192k');
  }

  // Subtitles
  if (o.subtitleMode === 'soft') {
    args.push('-c:s', 'mov_text');
  } else {
    // burn or none: drop subtitle streams
    args.push('-sn');
  }

  // MP4 tuning
  args.push('-movflags', '+faststart');
  args.push('-max_muxing_queue_size', '9999');

  args.push(job.output);
  return args;
}

// Unused cache placeholder
const streamTypeCache = new Map();

// ---- Health ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mediaRoot: MEDIA_ROOT, outputDir: OUTPUT_DIR });
});

// ---- Start server + WS ----
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.send(JSON.stringify({ type: 'hello', jobs: [...jobs.values()].map(publicJob) }));
    });
  } else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`MKVForge listening on :${PORT}`);
  console.log(`MEDIA_ROOT=${MEDIA_ROOT}`);
  console.log(`OUTPUT_DIR=${OUTPUT_DIR}`);
});

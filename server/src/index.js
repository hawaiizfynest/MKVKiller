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

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

function safeResolve(relPath) {
  const abs = path.resolve(MEDIA_ROOT, relPath || '.');
  const rootReal = fs.realpathSync(MEDIA_ROOT);
  if (!abs.startsWith(rootReal) && !abs.startsWith(MEDIA_ROOT)) {
    throw new Error('Path escapes MEDIA_ROOT');
  }
  return abs;
}

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

app.get('/api/probe', (req, res) => {
  try {
    const abs = safeResolve(req.query.path);
    const ff = spawn('ffprobe', [
      '-v', 'error', '-print_format', 'json',
      '-show_format', '-show_streams', abs
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

const jobs = new Map();
let running = 0;
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of sockets) if (ws.readyState === 1) ws.send(data);
}

function publicJob(j) {
  return {
    id: j.id, input: j.input, output: j.output, status: j.status,
    progress: j.progress, fps: j.fps, speed: j.speed, eta: j.eta,
    error: j.error, startedAt: j.startedAt, finishedAt: j.finishedAt,
    inputSize: j.inputSize, outputSize: j.outputSize,
    replacedOriginal: j.replacedOriginal || false,
    finalPath: j.finalPath || j.output
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

app.post('/api/convert', async (req, res) => {
  try {
    const {
      inputPath, selectedStreams, crf = 20, preset = 'slow',
      videoCodec = 'libx264', audioMode = 'auto', audioBitrate = '192k',
      subtitleMode = 'soft', burnSubIndex = null, maxHeight = null,
      outputName = null, replaceOriginal = false
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
      opts: { selectedStreams, crf, preset, videoCodec, audioMode, audioBitrate, subtitleMode, burnSubIndex, maxHeight, replaceOriginal },
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

  let duration = 0;
  try {
    const probeData = await probeFile(job.input);
    duration = probeData.format.duration || 0;
  } catch {}

  const args = buildFfmpegArgs(job);
  job.log.push('ffmpeg ' + args.join(' '));

  const proc = spawn('ffmpeg', args);
  job.proc = proc;

  proc.stderr.on('data', chunk => {
    const s = chunk.toString();
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

  proc.on('error', err => { job.status = 'error'; job.error = err.message; finishJob(job); });

  proc.on('close', async code => {
    if (job.cancelled) {
      job.status = 'cancelled';
      try { await fsp.unlink(job.output); } catch {}
    } else if (code === 0) {
      job.status = 'done';
      job.progress = 100;
      try { job.outputSize = (await fsp.stat(job.output)).size; } catch {}

      // Replace original if requested
      if (job.opts.replaceOriginal) {
        try {
          const finalPath = await replaceOriginalFile(job);
          job.finalPath = finalPath;
          job.replacedOriginal = true;
        } catch (e) {
          job.error = 'Converted OK but replace failed: ' + e.message;
          job.log.push('[replace error] ' + e.message);
        }
      }
    } else {
      job.status = 'error';
      job.error = 'ffmpeg exited ' + code;
    }
    finishJob(job);
  });
}

// Move converted file into source directory (renamed to .mp4) and delete the source.
// Safety rules:
//  - Source must still exist and be readable
//  - Converted output must exist and be non-zero
//  - If target path == source path, skip source deletion (same file)
//  - If target path already exists and isn't the source, fail rather than overwrite
//  - Copy-then-verify-then-delete pattern to survive crashes across filesystems
async function replaceOriginalFile(job) {
  const src = job.input;
  const out = job.output;
  const srcDir = path.dirname(src);
  const srcBase = path.basename(src, path.extname(src));
  const targetPath = path.join(srcDir, srcBase + '.mp4');

  // Verify output exists and has size
  const outStat = await fsp.stat(out);
  if (outStat.size < 1024) throw new Error('output file too small, aborting replace');

  // Make sure source still exists
  await fsp.access(src, fs.constants.R_OK);

  const sameFile = path.resolve(targetPath) === path.resolve(src);

  // If target path exists and isn't the source, refuse to clobber
  if (!sameFile) {
    try {
      await fsp.access(targetPath);
      throw new Error(`${targetPath} already exists, will not overwrite`);
    } catch (e) {
      if (e.code !== 'ENOENT' && !e.message.includes('already exists')) {
        // unexpected error
        throw e;
      }
      if (e.message.includes('already exists')) throw e;
      // ENOENT is what we want
    }
  }

  // Try a rename first (fast path, same filesystem)
  let moved = false;
  try {
    if (!sameFile) {
      // Rename output into place (same name as source with .mp4)
      await fsp.rename(out, targetPath);
      moved = true;
    }
  } catch (e) {
    if (e.code === 'EXDEV') {
      // Cross-device, fall back to copy + unlink
      await copyFile(out, targetPath);
      await fsp.unlink(out);
      moved = true;
    } else if (!sameFile) {
      throw e;
    }
  }

  // If target was the same as source (rare: source was already .mp4 in same dir),
  // we still need to move the converted file over it.
  if (sameFile) {
    // Copy converted output on top of source
    await copyFile(out, targetPath);
    await fsp.unlink(out);
    return targetPath; // source was replaced by copy, nothing more to delete
  }

  if (!moved) throw new Error('unexpected: file not moved');

  // Delete the original source (different from target since extensions/paths differ)
  try {
    await fsp.unlink(src);
  } catch (e) {
    job.log.push('[replace warning] could not delete source: ' + e.message);
  }

  return targetPath;
}

async function copyFile(src, dst) {
  await fsp.copyFile(src, dst);
  // Sanity check size
  const s = await fsp.stat(src);
  const d = await fsp.stat(dst);
  if (d.size !== s.size) throw new Error('copy size mismatch');
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

function buildFfmpegArgs(job) {
  const o = job.opts;
  const selected = new Set(o.selectedStreams || []);
  const args = ['-hide_banner', '-y', '-i', job.input];

  for (const i of selected) args.push('-map', `0:${i}`);

  args.push('-c:v', o.videoCodec || 'libx264');
  args.push('-preset', o.preset || 'slow');
  args.push('-crf', String(o.crf ?? 20));
  args.push('-pix_fmt', 'yuv420p');
  args.push('-profile:v', 'high');
  args.push('-level', '4.1');

  const vf = [];
  if (o.maxHeight) vf.push(`scale=-2:'min(${parseInt(o.maxHeight, 10)},ih)'`);
  if (o.subtitleMode === 'burn' && o.burnSubIndex != null) {
    const escaped = job.input.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    vf.push(`subtitles='${escaped}':si=${o.burnSubIndex}`);
  }
  if (vf.length) args.push('-vf', vf.join(','));

  if (o.audioMode === 'copy') args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', o.audioBitrate || '192k');

  if (o.subtitleMode === 'soft') args.push('-c:s', 'mov_text');
  else args.push('-sn');

  args.push('-movflags', '+faststart');
  args.push('-max_muxing_queue_size', '9999');
  args.push(job.output);
  return args;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mediaRoot: MEDIA_ROOT, outputDir: OUTPUT_DIR });
});

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

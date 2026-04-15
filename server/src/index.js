// MKVForge server - per-track control + HW encoding + persistent log + resumable encoding
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn, execSync } = require('child_process');
const http = require('http');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');
const Database = require('better-sqlite3');

const PORT = parseInt(process.env.PORT || '8080', 10);
const MEDIA_ROOT = process.env.MEDIA_ROOT || '/media';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(MEDIA_ROOT, 'converted');
const DATA_DIR = process.env.DATA_DIR || '/data';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '1', 10);
const SEGMENT_LENGTH = parseInt(process.env.SEGMENT_LENGTH || '600', 10); // 10 min default

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
const SCRATCH_DIR = path.join(DATA_DIR, 'scratch');
fs.mkdirSync(SCRATCH_DIR, { recursive: true });

// ---- SQLite ----
const db = new Database(path.join(DATA_DIR, 'mkvforge.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  input_size INTEGER,
  output_size INTEGER,
  status TEXT NOT NULL,           -- queued | running | done | error | cancelled | interrupted
  error TEXT,
  encoder TEXT,
  resumable INTEGER DEFAULT 0,
  duration REAL,
  segments_total INTEGER DEFAULT 0,
  segments_done INTEGER DEFAULT 0,
  options TEXT NOT NULL,          -- JSON of all encode options
  selected_streams TEXT,          -- JSON array of stream indices
  replace_original INTEGER DEFAULT 0,
  replaced_original INTEGER DEFAULT 0,
  final_path TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  log TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
`);

const insertJob = db.prepare(`INSERT INTO jobs
  (id, input, output, input_size, status, encoder, resumable, duration, options, selected_streams, replace_original, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const updateJob = db.prepare(`UPDATE jobs SET
  status=?, output_size=?, error=?, segments_total=?, segments_done=?,
  replaced_original=?, final_path=?, started_at=?, finished_at=?, log=?
  WHERE id=?`);
const updateProgress = db.prepare(`UPDATE jobs SET segments_done=?, status=? WHERE id=?`);
const getJob = db.prepare(`SELECT * FROM jobs WHERE id=?`);
const listJobs = db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`);
const listJobsByStatus = db.prepare(`SELECT * FROM jobs WHERE status=? ORDER BY created_at DESC`);
const deleteJobRow = db.prepare(`DELETE FROM jobs WHERE id=?`);

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id, input: row.input, output: row.output,
    inputSize: row.input_size, outputSize: row.output_size,
    status: row.status, error: row.error, encoder: row.encoder,
    resumable: !!row.resumable, duration: row.duration,
    segmentsTotal: row.segments_total, segmentsDone: row.segments_done,
    progress: row.segments_total ? Math.min(100, (row.segments_done / row.segments_total) * 100) : 0,
    options: row.options ? JSON.parse(row.options) : {},
    selectedStreams: row.selected_streams ? JSON.parse(row.selected_streams) : [],
    replaceOriginal: !!row.replace_original,
    replacedOriginal: !!row.replaced_original,
    finalPath: row.final_path,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at
  };
}

// ---- Express ----
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// ---- Capabilities ----
const caps = { cpu: true, qsv: false, nvenc: false, vaapi: false, detectedAt: null, details: {} };

function probeFFmpegEncoders() {
  try {
    const out = execSync('ffmpeg -hide_banner -encoders 2>&1', { encoding: 'utf8' });
    return { h264_qsv: out.includes('h264_qsv'), h264_nvenc: out.includes('h264_nvenc'), h264_vaapi: out.includes('h264_vaapi') };
  } catch { return {}; }
}
function testEncoder(codec) {
  try {
    execSync(`ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=320x240:d=0.1 -c:v ${codec} -frames:v 1 -f null - 2>&1`, { stdio: 'pipe', timeout: 8000 });
    return true;
  } catch { return false; }
}
function detectCapabilities() {
  const enc = probeFFmpegEncoders();
  caps.details = { encoders: enc };
  let hasDri = false;
  try { const dri = fs.readdirSync('/dev/dri'); caps.details.dri = dri; hasDri = dri.some(f => f.startsWith('renderD')); }
  catch { caps.details.dri = []; }
  if (enc.h264_qsv && hasDri) caps.qsv = testEncoder('h264_qsv');
  if (enc.h264_nvenc) caps.nvenc = testEncoder('h264_nvenc');
  caps.vaapi = enc.h264_vaapi && hasDri;
  caps.detectedAt = new Date().toISOString();
  console.log(`[caps] cpu=true qsv=${caps.qsv} nvenc=${caps.nvenc}`);
}
detectCapabilities();

// ---- Path safety ----
function safeResolve(relPath) {
  const abs = path.resolve(MEDIA_ROOT, relPath || '.');
  const rootReal = fs.realpathSync(MEDIA_ROOT);
  if (!abs.startsWith(rootReal) && !abs.startsWith(MEDIA_ROOT)) throw new Error('Path escapes MEDIA_ROOT');
  return abs;
}

// ---- API: browse / probe / capabilities / health ----
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
      items.push({ name: e.name, dir: e.isDirectory(), size, path: path.relative(MEDIA_ROOT, full) });
    }
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    res.json({ cwd: path.relative(MEDIA_ROOT, abs) || '', items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/probe', (req, res) => {
  try {
    const abs = safeResolve(req.query.path);
    const ff = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs]);
    let out = '', err = '';
    ff.stdout.on('data', d => out += d);
    ff.stderr.on('data', d => err += d);
    ff.on('close', code => {
      if (code !== 0) return res.status(500).json({ error: err || 'ffprobe failed' });
      try {
        const data = JSON.parse(out);
        const streams = (data.streams || []).map(s => ({
          index: s.index, codec_type: s.codec_type, codec_name: s.codec_name,
          language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || 'und',
          title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
          channels: s.channels, channel_layout: s.channel_layout,
          width: s.width, height: s.height, bit_rate: s.bit_rate,
          default: s.disposition && s.disposition.default ? 1 : 0,
          forced: s.disposition && s.disposition.forced ? 1 : 0
        }));
        res.json({
          format: { duration: parseFloat(data.format.duration || 0), size: parseInt(data.format.size || 0, 10), bit_rate: parseInt(data.format.bit_rate || 0, 10), format_name: data.format.format_name },
          streams
        });
      } catch (e) { res.status(500).json({ error: 'parse failed: ' + e.message }); }
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/capabilities', (req, res) => res.json(caps));
app.get('/api/health', (req, res) => res.json({ ok: true, mediaRoot: MEDIA_ROOT, outputDir: OUTPUT_DIR, dataDir: DATA_DIR, capabilities: caps }));

// ---- Job state ----
const activeJobs = new Map(); // id -> runtime state (proc, progress, etc.)
let running = 0;
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set();
function broadcast(msg) { const data = JSON.stringify(msg); for (const ws of sockets) if (ws.readyState === 1) ws.send(data); }

function publicJob(id) {
  const row = getJob.get(id);
  if (!row) return null;
  const j = rowToJob(row);
  const live = activeJobs.get(id);
  if (live) {
    if (live.fps != null) j.fps = live.fps;
    if (live.speed != null) j.speed = live.speed;
    if (live.eta != null) j.eta = live.eta;
    if (live.currentSegment != null) j.currentSegment = live.currentSegment;
  }
  return j;
}

app.get('/api/jobs', (req, res) => {
  const rows = listJobs.all(500);
  const list = rows.map(r => publicJob(r.id)).filter(Boolean);
  res.json(list);
});
app.get('/api/jobs/:id/log', (req, res) => {
  const row = getJob.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ log: row.log || '' });
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  const id = req.params.id;
  const live = activeJobs.get(id);
  if (live && live.proc) { live.cancelled = true; live.proc.kill('SIGTERM'); return res.json({ ok: true }); }
  const row = getJob.get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.status === 'queued' || row.status === 'interrupted') {
    db.prepare('UPDATE jobs SET status=?, finished_at=? WHERE id=?').run('cancelled', Date.now(), id);
    broadcast({ type: 'job', job: publicJob(id) });
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'cannot cancel in state ' + row.status });
});
app.delete('/api/jobs/:id', (req, res) => {
  const id = req.params.id;
  const row = getJob.get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.status === 'running') return res.status(400).json({ error: 'running' });
  // Clean scratch
  try { fs.rmSync(path.join(SCRATCH_DIR, id), { recursive: true, force: true }); } catch {}
  deleteJobRow.run(id);
  broadcast({ type: 'removed', id });
  res.json({ ok: true });
});

// ---- Submit ----
app.post('/api/convert', async (req, res) => {
  try {
    const {
      inputPath, selectedStreams,
      crf = 20, preset = 'slow',
      encoder = 'cpu', hwQuality = 23,
      audioMode = 'auto', audioBitrate = '192k',
      subtitleMode = 'soft', burnSubIndex = null,
      maxHeight = null, outputName = null,
      replaceOriginal = false,
      resumable = false
    } = req.body || {};

    if (!inputPath) return res.status(400).json({ error: 'inputPath required' });
    if (encoder === 'qsv' && !caps.qsv) return res.status(400).json({ error: 'QSV not available' });
    if (encoder === 'nvenc' && !caps.nvenc) return res.status(400).json({ error: 'NVENC not available' });

    const absIn = safeResolve(inputPath);
    await fsp.access(absIn, fs.constants.R_OK);
    const stat = await fsp.stat(absIn);

    const base = outputName || path.basename(absIn, path.extname(absIn)) + '.mp4';
    const safeBase = base.replace(/[/\\]/g, '_');
    const absOut = path.join(OUTPUT_DIR, safeBase);

    // Probe duration so we can compute segment count
    let duration = 0;
    try { duration = (await probeFile(absIn)).format.duration || 0; } catch {}
    const segmentsTotal = resumable && duration > 0 ? Math.ceil(duration / SEGMENT_LENGTH) : 1;

    const id = nanoid(10);
    const opts = { selectedStreams, crf, preset, encoder, hwQuality, audioMode, audioBitrate, subtitleMode, burnSubIndex, maxHeight };

    insertJob.run(
      id, absIn, absOut, stat.size, 'queued',
      encoder, resumable ? 1 : 0, duration,
      JSON.stringify(opts), JSON.stringify(selectedStreams || []),
      replaceOriginal ? 1 : 0, Date.now()
    );

    broadcast({ type: 'job', job: publicJob(id) });
    res.json({ id });
    pump();
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Restart an interrupted/cancelled/failed job (preserving segments if resumable)
app.post('/api/jobs/:id/restart', (req, res) => {
  const id = req.params.id;
  const row = getJob.get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.status === 'running' || row.status === 'queued') return res.status(400).json({ error: 'already active' });
  db.prepare('UPDATE jobs SET status=?, error=?, started_at=NULL, finished_at=NULL WHERE id=?').run('queued', null, id);
  broadcast({ type: 'job', job: publicJob(id) });
  pump();
  res.json({ ok: true });
});

// ---- Probe helper ----
function probeFile(abs) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs]);
    let out = '';
    ff.stdout.on('data', d => out += d);
    ff.on('close', code => { if (code !== 0) return reject(new Error('ffprobe failed')); try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
  });
}

// ---- Encode pipeline ----
function pump() {
  if (running >= MAX_CONCURRENT) return;
  const queued = listJobsByStatus.all('queued');
  if (!queued.length) return;
  runJob(queued[0].id);
}

function appendLog(id, text) {
  const row = getJob.get(id);
  let log = row.log || '';
  log += text;
  if (log.length > 200_000) log = log.slice(-200_000);
  db.prepare('UPDATE jobs SET log=? WHERE id=?').run(log, id);
}

async function runJob(id) {
  const row = getJob.get(id);
  if (!row) return;
  running++;

  const j = rowToJob(row);
  db.prepare('UPDATE jobs SET status=?, started_at=COALESCE(started_at, ?) WHERE id=?').run('running', Date.now(), id);
  broadcast({ type: 'job', job: publicJob(id) });

  try {
    if (j.resumable && j.duration > 0) {
      await runSegmented(j);
    } else {
      await runSingle(j);
    }
  } catch (e) {
    appendLog(id, '\n[runner error] ' + e.message + '\n');
    db.prepare('UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?').run('error', e.message, Date.now(), id);
  }

  activeJobs.delete(id);
  running--;
  broadcast({ type: 'job', job: publicJob(id) });
  pump();
}

// --- Single-pass (non-resumable) ----
function runSingle(j) {
  return new Promise((resolve) => {
    const args = buildSinglePassArgs(j);
    appendLog(j.id, 'ffmpeg ' + args.join(' ') + '\n');
    const proc = spawn('ffmpeg', args);
    activeJobs.set(j.id, { proc, fps: 0, speed: 0, eta: 0, currentSegment: null });
    const live = activeJobs.get(j.id);

    proc.stderr.on('data', chunk => {
      const s = chunk.toString();
      const tm = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (tm && j.duration > 0) {
        const sec = (+tm[1]) * 3600 + (+tm[2]) * 60 + parseFloat(tm[3]);
        const pct = Math.min(100, (sec / j.duration) * 100);
        // Repurpose segments_done for progress when not segmented
        updateProgress.run(Math.round(pct), 'running', j.id);
      }
      const fpsM = s.match(/fps=\s*([\d.]+)/);
      if (fpsM) live.fps = parseFloat(fpsM[1]);
      const spM = s.match(/speed=\s*([\d.]+)x/);
      if (spM) live.speed = parseFloat(spM[1]);
      if (live.speed && j.duration > 0) {
        const r = getJob.get(j.id);
        live.eta = Math.round((j.duration * (1 - r.segments_done/100)) / live.speed);
      }
      appendLog(j.id, s);
      broadcast({ type: 'progress', id: j.id, fps: live.fps, speed: live.speed, eta: live.eta, progress: getJob.get(j.id).segments_done });
    });
    // Tell client this job uses % directly via segments_total=100
    db.prepare('UPDATE jobs SET segments_total=? WHERE id=?').run(100, j.id);

    proc.on('error', err => {
      db.prepare('UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?').run('error', err.message, Date.now(), j.id);
      resolve();
    });
    proc.on('close', async (code) => {
      if (live.cancelled) {
        try { await fsp.unlink(j.output); } catch {}
        db.prepare('UPDATE jobs SET status=?, finished_at=? WHERE id=?').run('cancelled', Date.now(), j.id);
      } else if (code === 0) {
        let outSize = 0;
        try { outSize = (await fsp.stat(j.output)).size; } catch {}
        db.prepare('UPDATE jobs SET status=?, output_size=?, segments_done=?, finished_at=? WHERE id=?').run('done', outSize, 100, Date.now(), j.id);
        await maybeReplaceOriginal(j);
      } else {
        db.prepare('UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?').run('error', 'ffmpeg exited ' + code, Date.now(), j.id);
      }
      resolve();
    });
  });
}

// --- Segmented (resumable) ----
async function runSegmented(j) {
  const scratchDir = path.join(SCRATCH_DIR, j.id);
  fs.mkdirSync(scratchDir, { recursive: true });
  const segCount = Math.ceil(j.duration / SEGMENT_LENGTH);
  db.prepare('UPDATE jobs SET segments_total=? WHERE id=?').run(segCount, j.id);

  // Find which segments are already done (file exists with non-trivial size)
  const segDone = (i) => {
    const p = path.join(scratchDir, `seg_${String(i).padStart(4,'0')}.mp4`);
    try { return fs.statSync(p).size > 1024; } catch { return false; }
  };

  let completed = 0;
  for (let i = 0; i < segCount; i++) if (segDone(i)) completed++;
  updateProgress.run(completed, 'running', j.id);
  appendLog(j.id, `\n[resume] ${completed}/${segCount} segments already complete\n`);
  broadcast({ type: 'job', job: publicJob(j.id) });

  // Encode missing segments sequentially
  for (let i = 0; i < segCount; i++) {
    if (segDone(i)) continue;
    const ok = await encodeSegment(j, scratchDir, i, segCount);
    if (!ok) {
      // either cancelled or hard failed
      const live = activeJobs.get(j.id);
      if (live && live.cancelled) {
        db.prepare('UPDATE jobs SET status=?, finished_at=? WHERE id=?').run('cancelled', Date.now(), j.id);
        return;
      }
      // Mark interrupted - state is preserved on disk for resume later
      db.prepare('UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?').run('interrupted', 'segment ' + i + ' failed', Date.now(), j.id);
      return;
    }
    completed++;
    updateProgress.run(completed, 'running', j.id);
    broadcast({ type: 'job', job: publicJob(j.id) });
  }

  // Concatenate segments via ffmpeg concat demuxer
  appendLog(j.id, '\n[concat] joining ' + segCount + ' segments\n');
  const listFile = path.join(scratchDir, 'concat.txt');
  fs.writeFileSync(listFile, [...Array(segCount).keys()].map(i => `file '${path.join(scratchDir, `seg_${String(i).padStart(4,'0')}.mp4`)}'`).join('\n'));

  const concatOk = await new Promise(resolve => {
    const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', j.output];
    appendLog(j.id, 'ffmpeg ' + args.join(' ') + '\n');
    const p = spawn('ffmpeg', args);
    p.stderr.on('data', d => appendLog(j.id, d.toString()));
    p.on('close', code => resolve(code === 0));
  });

  if (!concatOk) {
    db.prepare('UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?').run('error', 'concat failed', Date.now(), j.id);
    return;
  }

  let outSize = 0;
  try { outSize = (await fsp.stat(j.output)).size; } catch {}
  db.prepare('UPDATE jobs SET status=?, output_size=?, segments_done=?, finished_at=? WHERE id=?').run('done', outSize, segCount, Date.now(), j.id);
  await maybeReplaceOriginal(j);

  // Clean scratch
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
}

function encodeSegment(j, scratchDir, segIdx, segCount) {
  return new Promise((resolve) => {
    const startTime = segIdx * SEGMENT_LENGTH;
    const segDuration = Math.min(SEGMENT_LENGTH, j.duration - startTime);
    const segOut = path.join(scratchDir, `seg_${String(segIdx).padStart(4,'0')}.mp4`);
    const args = buildSegmentArgs(j, startTime, segDuration, segOut);
    appendLog(j.id, `\n[seg ${segIdx+1}/${segCount}] ffmpeg ` + args.join(' ') + '\n');

    const proc = spawn('ffmpeg', args);
    const existing = activeJobs.get(j.id) || {};
    activeJobs.set(j.id, { ...existing, proc, currentSegment: segIdx + 1 });
    const live = activeJobs.get(j.id);

    proc.stderr.on('data', chunk => {
      const s = chunk.toString();
      const fpsM = s.match(/fps=\s*([\d.]+)/); if (fpsM) live.fps = parseFloat(fpsM[1]);
      const spM = s.match(/speed=\s*([\d.]+)x/); if (spM) live.speed = parseFloat(spM[1]);
      if (live.speed && j.duration > 0) {
        const r = getJob.get(j.id);
        const remainingSec = j.duration - (r.segments_done * SEGMENT_LENGTH);
        live.eta = Math.round(remainingSec / live.speed);
      }
      appendLog(j.id, s);
      broadcast({ type: 'progress', id: j.id, fps: live.fps, speed: live.speed, eta: live.eta, progress: getJob.get(j.id).segments_done, currentSegment: live.currentSegment });
    });
    proc.on('error', () => resolve(false));
    proc.on('close', code => {
      if (live.cancelled) { try { fs.unlinkSync(segOut); } catch {} return resolve(false); }
      resolve(code === 0);
    });
  });
}

// --- Replace original logic ---
async function maybeReplaceOriginal(j) {
  const row = getJob.get(j.id);
  if (!row.replace_original) return;
  try {
    const finalPath = await replaceOriginalFile(j);
    db.prepare('UPDATE jobs SET replaced_original=1, final_path=? WHERE id=?').run(finalPath, j.id);
  } catch (e) {
    appendLog(j.id, '[replace error] ' + e.message + '\n');
    db.prepare('UPDATE jobs SET error=? WHERE id=?').run('Converted OK but replace failed: ' + e.message, j.id);
  }
}

async function replaceOriginalFile(j) {
  const src = j.input, out = j.output;
  const targetPath = path.join(path.dirname(src), path.basename(src, path.extname(src)) + '.mp4');
  const outStat = await fsp.stat(out);
  if (outStat.size < 1024) throw new Error('output file too small');
  await fsp.access(src, fs.constants.R_OK);
  const sameFile = path.resolve(targetPath) === path.resolve(src);
  if (!sameFile) {
    try { await fsp.access(targetPath); throw new Error(`${targetPath} already exists`); }
    catch (e) { if (e.code !== 'ENOENT' && !e.message.includes('already exists')) throw e; if (e.message.includes('already exists')) throw e; }
  }
  let moved = false;
  try { if (!sameFile) { await fsp.rename(out, targetPath); moved = true; } }
  catch (e) {
    if (e.code === 'EXDEV') { await fsp.copyFile(out, targetPath); await fsp.unlink(out); moved = true; }
    else if (!sameFile) throw e;
  }
  if (sameFile) { await fsp.copyFile(out, targetPath); await fsp.unlink(out); return targetPath; }
  if (!moved) throw new Error('not moved');
  try { await fsp.unlink(src); } catch {}
  return targetPath;
}

// ---- ffmpeg arg builders ----
function videoEncoderArgs(opts) {
  const enc = opts.encoder || 'cpu';
  const args = [];
  if (enc === 'qsv') {
    args.push('-c:v', 'h264_qsv', '-preset', mapQSVPreset(opts.preset),
      '-global_quality', String(opts.hwQuality ?? 23), '-look_ahead', '1',
      '-profile:v', 'high');
  } else if (enc === 'nvenc') {
    args.push('-c:v', 'h264_nvenc', '-preset', mapNVENCPreset(opts.preset),
      '-rc', 'vbr', '-cq', String(opts.hwQuality ?? 23), '-b:v', '0',
      '-profile:v', 'high', '-rc-lookahead', '20', '-spatial_aq', '1');
  } else {
    args.push('-c:v', 'libx264', '-preset', opts.preset || 'slow',
      '-crf', String(opts.crf ?? 20), '-profile:v', 'high', '-level', '4.1');
  }
  args.push('-pix_fmt', 'yuv420p');
  return args;
}

function vfArgs(opts) {
  const enc = opts.encoder || 'cpu';
  const vf = [];
  if (opts.maxHeight) {
    if (enc === 'qsv') vf.push(`scale_qsv=-1:'min(${parseInt(opts.maxHeight, 10)},ih)'`);
    else if (enc === 'nvenc') vf.push(`scale_cuda=-2:'min(${parseInt(opts.maxHeight, 10)},ih)'`);
    else vf.push(`scale=-2:'min(${parseInt(opts.maxHeight, 10)},ih)'`);
  }
  return vf;
}

function audioArgs(opts) {
  if (opts.audioMode === 'copy') return ['-c:a', 'copy'];
  return ['-c:a', 'aac', '-b:a', opts.audioBitrate || '192k'];
}

function buildSinglePassArgs(j) {
  const o = j.options;
  const enc = o.encoder || 'cpu';
  const pre = ['-hide_banner', '-y'];
  if (enc === 'nvenc') pre.push('-hwaccel', 'cuda');
  else if (enc === 'qsv') pre.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
  pre.push('-i', j.input);

  const args = [...pre];
  for (const i of (j.selectedStreams || [])) args.push('-map', `0:${i}`);

  const vf = vfArgs(o);
  if (o.subtitleMode === 'burn' && o.burnSubIndex != null) {
    if (enc !== 'cpu') vf.length = 0; // burn-in needs CPU pixel access
    if (o.maxHeight && vf.length === 0) vf.push(`scale=-2:'min(${parseInt(o.maxHeight, 10)},ih)'`);
    const escaped = j.input.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    vf.push(`subtitles='${escaped}':si=${o.burnSubIndex}`);
  }
  if (vf.length) args.push('-vf', vf.join(','));

  args.push(...videoEncoderArgs(o), ...audioArgs(o));
  if (o.subtitleMode === 'soft') args.push('-c:s', 'mov_text'); else args.push('-sn');
  args.push('-movflags', '+faststart', '-max_muxing_queue_size', '9999', j.output);
  return args;
}

function buildSegmentArgs(j, startTime, segDuration, segOut) {
  // Segmented mode: only video + first selected audio track for simplicity & soft subs dropped during segments
  // (subtitles re-added would complicate concat; we drop them in resumable mode and warn user in UI)
  const o = j.options;
  const enc = o.encoder || 'cpu';
  const pre = ['-hide_banner', '-y'];
  if (enc === 'nvenc') pre.push('-hwaccel', 'cuda');
  else if (enc === 'qsv') pre.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
  pre.push('-ss', String(startTime), '-i', j.input, '-t', String(segDuration));

  const args = [...pre];
  // Map only video and audio (skip subs; mov_text segments don't concat cleanly)
  const streams = j.selectedStreams || [];
  for (const i of streams) {
    // we don't have stream type here, just map all selected non-subtitle streams.
    // (server caches type via probe? simpler: just map all and ignore -sn for subs below)
    args.push('-map', `0:${i}?`); // ? means optional, skip if absent
  }

  const vf = vfArgs(o);
  if (vf.length) args.push('-vf', vf.join(','));
  args.push(...videoEncoderArgs(o), ...audioArgs(o));
  args.push('-sn'); // no subs in segments (resumable mode strips them)
  args.push('-movflags', '+faststart', '-max_muxing_queue_size', '9999', '-reset_timestamps', '1', segOut);
  return args;
}

function mapQSVPreset(p) { return ['veryfast','faster','fast','medium','slow','slower','veryslow'].includes(p) ? p : 'slow'; }
function mapNVENCPreset(p) { const m = { ultrafast:'p1', superfast:'p1', veryfast:'p2', faster:'p3', fast:'p4', medium:'p5', slow:'p6', slower:'p7', veryslow:'p7' }; return m[p] || 'p6'; }

// ---- Recovery on startup: mark previously-running jobs as interrupted ----
function recoverOnStartup() {
  const stuck = db.prepare(`SELECT id, resumable FROM jobs WHERE status='running'`).all();
  for (const r of stuck) {
    if (r.resumable) {
      db.prepare('UPDATE jobs SET status=? WHERE id=?').run('interrupted', r.id);
      console.log(`[recover] job ${r.id} marked interrupted (resumable)`);
    } else {
      db.prepare('UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?').run('error', 'container restarted mid-encode (not resumable)', Date.now(), r.id);
      console.log(`[recover] job ${r.id} marked failed (not resumable)`);
    }
  }
}
recoverOnStartup();

// ---- WS + listen ----
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      const jobs = listJobs.all(500).map(r => publicJob(r.id)).filter(Boolean);
      ws.send(JSON.stringify({ type: 'hello', jobs, capabilities: caps }));
    });
  } else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`MKVForge listening on :${PORT}`);
  console.log(`MEDIA_ROOT=${MEDIA_ROOT} OUTPUT_DIR=${OUTPUT_DIR} DATA_DIR=${DATA_DIR}`);
  // Auto-resume any interrupted jobs immediately
  setTimeout(() => {
    const interrupted = listJobsByStatus.all('interrupted');
    if (interrupted.length) {
      console.log(`[startup] auto-resuming ${interrupted.length} interrupted job(s)`);
      for (const r of interrupted) db.prepare('UPDATE jobs SET status=? WHERE id=?').run('queued', r.id);
      pump();
    }
  }, 1000);
});

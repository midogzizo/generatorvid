// طبقة قاعدة البيانات — Turso (libSQL). كل شيء يُخزَّن هنا: المهام، أجزاء المصادر، والناتج (Blobs)
// لا S3 ولا خدمات خارجية — Blobs مقسومة صفوفًا 2MB (حد HTTP في Turso) وتُقرأ صفحات 8 صفوف.
const { createClient } = require("@libsql/client");

let client = null;

function db() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) throw new Error("متغيرات TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزامية");
    client = createClient({ url, authToken: token });
  }
  return client;
}

let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const c = db();
      await c.execute(`CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'queued',
        progress INTEGER DEFAULT 0,
        error TEXT,
        video_size INTEGER,
        video_duration REAL,
        video_resolution TEXT,
        expires_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT
      )`);
      await c.execute(`CREATE TABLE IF NOT EXISTS sources (
        job_id TEXT, seq INTEGER, kind TEXT, url TEXT, name TEXT, size INTEGER, mime TEXT, uploaded INTEGER DEFAULT 0,
        PRIMARY KEY (job_id, seq)
      )`);
      await c.execute(`CREATE TABLE IF NOT EXISTS source_chunks (
        job_id TEXT, seq INTEGER, chunk_idx INTEGER, data BLOB,
        PRIMARY KEY (job_id, seq, chunk_idx)
      )`);
      await c.execute(`CREATE TABLE IF NOT EXISTS output_chunks (
        job_id TEXT, chunk_idx INTEGER, data BLOB,
        PRIMARY KEY (job_id, chunk_idx)
      )`);
      await c.execute(`CREATE INDEX IF NOT EXISTS idx_jobs_expiry ON jobs (expires_at)`);
    })();
  }
  return schemaPromise;
}

function nowUtc() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function insertJob(job) {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO jobs (id, status, progress, expires_at, updated_at) VALUES (?, ?, 0, ?, ?)`,
    args: [job.id, job.status, job.expires_at, nowUtc()],
  });
}

async function getJob(id) {
  await ensureSchema();
  const rs = await db().execute({ sql: `SELECT * FROM jobs WHERE id = ?`, args: [id] });
  return rs.rows[0] || null;
}

async function updateJob(id, patch) {
  await ensureSchema();
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (!sets.length) return;
  sets.push(`updated_at = ?`);
  args.push(nowUtc());
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

async function listJobs(limit = 20) {
  await ensureSchema();
  const rs = await db().execute({ sql: `SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`, args: [limit] });
  return rs.rows;
}

async function insertSource(jobId, seq, src) {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO sources (job_id, seq, kind, url, name, size, mime, uploaded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [jobId, seq, src.kind, src.url || null, src.name || null, src.size || null, src.mime || null, src.kind === "url" ? 1 : 0],
  });
}

async function listSources(jobId) {
  await ensureSchema();
  const rs = await db().execute({ sql: `SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC`, args: [jobId] });
  return rs.rows;
}

async function nextSourceChunkIdx(jobId, seq) {
  const rs = await db().execute({ sql: `SELECT COALESCE(MAX(chunk_idx), -1) AS m FROM source_chunks WHERE job_id = ? AND seq = ?`, args: [jobId, seq] });
  return Number(rs.rows[0].m) + 1;
}

// تخزين Buffer كصفوف ≤2MB
const CHUNK_ROW_BYTES = 2 * 1024 * 1024;
async function appendSourceChunk(jobId, seq, buf) {
  await ensureSchema();
  const start = await nextSourceChunkIdx(jobId, seq);
  const batches = [];
  for (let off = 0; off < buf.length; off += CHUNK_ROW_BYTES) {
    const idx = start + off / CHUNK_ROW_BYTES;
    batches.push({ sql: `INSERT INTO source_chunks (job_id, seq, chunk_idx, data) VALUES (?, ?, ?, ?)`, args: [jobId, seq, idx, buf.subarray(off, Math.min(buf.length, off + CHUNK_ROW_BYTES))] });
  }
  if (batches.length) await db().batch(batches);
  await db().execute({ sql: `UPDATE sources SET uploaded = COALESCE(uploaded, 0) + ? WHERE job_id = ? AND seq = ?`, args: [buf.length, jobId, seq] });
}

async function readSourceBytes(jobId, seq) {
  await ensureSchema();
  // قراءة صفحات 8 صفوف لتجميع الملف كاملًا في الذاكرة (حدود المصادر ≤200MB معقولة لحالة النجاح فقط)
  const parts = [];
  let offset = 0;
  for (;;) {
    const rs = await db().execute({ sql: `SELECT chunk_idx, data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk_idx ASC LIMIT 8 OFFSET ?`, args: [jobId, seq, offset] });
    for (const r of rs.rows) parts.push(Buffer.from(r.data));
    if (rs.rows.length < 8) break;
    offset += 8;
  }
  return Buffer.concat(parts);
}

async function appendOutputChunks(jobId, buf) {
  await ensureSchema();
  const batches = [];
  for (let off = 0; off < buf.length; off += CHUNK_ROW_BYTES) {
    const idx = off / CHUNK_ROW_BYTES;
    batches.push({ sql: `INSERT INTO output_chunks (job_id, chunk_idx, data) VALUES (?, ?, ?)`, args: [jobId, idx, buf.subarray(off, Math.min(buf.length, off + CHUNK_ROW_BYTES))] });
  }
  if (batches.length) await db().batch(batches);
}

// قائمة إزاحات الصفوف المطلوبة لتغطية المدى [start,end] (شاملة)
function rowsForRange(start, end, rowBytes = CHUNK_ROW_BYTES) {
  const first = Math.floor(start / rowBytes);
  const last = Math.floor(end / rowBytes);
  const rows = [];
  for (let i = first; i <= last; i++) rows.push(i);
  return { rows, offsetInFirst: start - first * rowBytes, lenInLast: end - last * rowBytes + 1 };
}

async function readOutputRange(jobId, start, end) {
  await ensureSchema();
  const { rows } = rowsForRange(start, end);
  const parts = [];
  for (const idx of rows) {
    const rs = await db().execute({ sql: `SELECT data FROM output_chunks WHERE job_id = ? AND chunk_idx = ?`, args: [jobId, idx] });
    if (!rs.rows.length) return null;
    const data = Buffer.from(rs.rows[0].data);
    // حساب التداخل الفعلي للصف مع المدى المطلوب [start, end]
    const rowStart = idx * CHUNK_ROW_BYTES;
    const rowEnd = rowStart + data.length - 1;
    const from = Math.max(start, rowStart) - rowStart;
    const to = Math.min(end, rowEnd) - rowStart;
    if (to < from) return null;
    parts.push(data.subarray(from, to + 1));
  }
  return Buffer.concat(parts);
}

async function totalBytes(table, jobId) {
  const rs = await db().execute({ sql: `SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM ${table} WHERE job_id = ?`, args: [jobId] });
  return Number(rs.rows[0].n);
}

// حذف شامل في batch واحد — jobs + sources + source_chunks + output_chunks
async function deleteJobCompletely(jobId) {
  await ensureSchema();
  await db().batch([
    { sql: `DELETE FROM jobs WHERE id = ?`, args: [jobId] },
    { sql: `DELETE FROM sources WHERE job_id = ?`, args: [jobId] },
    { sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] },
    { sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [jobId] },
  ]);
}

async function deleteSourceChunks(jobId) {
  await ensureSchema();
  await db().execute({ sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] });
}

// تنظيف كسول للمهام المنتهية (تُنفَّذ عند كل إنشاء/دمج + عبر /api/cron يوميًا)
async function purgeExpired() {
  await ensureSchema();
  const rs = await db().execute({ sql: `SELECT id FROM jobs WHERE expires_at <= ?`, args: [nowUtc()] });
  for (const r of rs.rows) {
    await deleteJobCompletely(String(r.id));
  }
  return rs.rows.length;
}

module.exports = {
  db, ensureSchema, nowUtc,
  insertJob, getJob, updateJob, listJobs,
  insertSource, listSources,
  appendSourceChunk, readSourceBytes,
  appendOutputChunks, readOutputRange, totalBytes,
  deleteJobCompletely, deleteSourceChunks, purgeExpired,
  CHUNK_ROW_BYTES,
};

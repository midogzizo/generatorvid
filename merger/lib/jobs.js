// منطق المهام المشترك بين مسارات API
const crypto = require("node:crypto");
const store = require("./db");
const { runMergeJob } = require("./merge");
const limits = require("./limits");

const BASE_ORIGIN = () => (process.env.MERGER_PUBLIC_BASE || "").replace(/\/+$/, "");

// اشتقاق الأصل العام من ترويسات الطلب (X-Forwarded-* على Vercel، Host محليًا) — MERGER_PUBLIC_BASE يتجاوزه
function originFromReq(req) {
  const fixed = BASE_ORIGIN();
  if (fixed) return fixed;
  const proto = String(req.headers["x-forwarded-proto"] || (req.socket && req.socket.encrypted ? "https" : "http"));
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost");
  return `${proto}://${host}`;
}

function newJobId() {
  return crypto.randomBytes(6).toString("base64url"); // مثل wkucdefoxwvd
}

function publicUrls(jobId, origin) {
  const base = (origin || "https://localhost").replace(/\/+$/, "");
  return {
    statusUrl: `${base}/api/jobs/${jobId}`,
    processUrl: `${base}/api/jobs/${jobId}/process`,
    videoUrl: `${base}/api/jobs/${jobId}/video`,
    downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
  };
}

function expiryIso() {
  const d = new Date(Date.now() + limits.EXPIRY_HOURS * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// التحقق الصارم من الروابط: http/https مباشرة وعامة
function validPublicUrl(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== "http:" && p.protocol !== "https:") return false;
    const h = p.hostname.toLowerCase();
    if (h === "localhost" || h === "::1" || h.endsWith(".local")) return false;
    if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

// إنشاء مهمة من {"videos":[...]} أو {"sources":[{kind,url|name,size,mime}]}
async function createJobFromPayload(payload, origin) {
  await store.purgeExpired(); // تنظيف كسول عند كل إنشاء
  let entries = [];
  if (Array.isArray(payload.videos)) {
    for (const v of payload.videos) {
      if (typeof v !== "string" || !validPublicUrl(v)) {
        throw Object.assign(new Error(`الرابط يجب أن يكون رابط فيديو مباشر عام (http/https): ${v}`), { statusCode: 400 });
      }
      entries.push({ kind: "url", url: v });
    }
  } else if (Array.isArray(payload.sources)) {
    for (const s of payload.sources) {
      if (s.kind === "url") {
        if (!validPublicUrl(s.url)) throw Object.assign(new Error(`الرابط يجب أن يكون مباشرًا عامًا: ${s.url}`), { statusCode: 400 });
        entries.push({ kind: "url", url: s.url });
      } else if (s.kind === "file") {
        entries.push({ kind: "file", name: String(s.name || "file").slice(0, 120), size: Number(s.size || 0), mime: String(s.mime || "video/mp4").slice(0, 80) });
      } else {
        throw Object.assign(new Error("نوع المصدر يجب أن يكون url أو file"), { statusCode: 400 });
      }
    }
  } else {
    throw Object.assign(new Error("يجب تمرير videos أو sources"), { statusCode: 400 });
  }

  if (entries.length < 2) throw Object.assign(new Error("الدمج يحتاج مقطعَين على الأقل"), { statusCode: 400 });
  if (entries.length > limits.MAX_SOURCES) {
    throw Object.assign(new Error(`أقصى عدد مقاطع للدمج هو ${limits.MAX_SOURCES}`), { statusCode: 400 });
  }
  for (const e of entries) {
    if (e.size && e.size > limits.SOURCE_MAX_MB * 1024 * 1024) {
      throw Object.assign(new Error(`حجم المصدر يتجاوز الحد (${limits.SOURCE_MAX_MB}MB)`), { statusCode: 413 });
    }
  }

  const jobId = newJobId();
  const hasFiles = entries.some((e) => e.kind === "file");
  await store.insertJob({ id: jobId, status: hasFiles ? "uploading" : "queued", expires_at: expiryIso() });
  for (let i = 0; i < entries.length; i++) {
    await store.insertSource(jobId, i, entries[i]);
  }
  const urls = publicUrls(jobId, origin);
  const resp = { jobId, status: hasFiles ? "uploading" : "queued", ...urls, expiresAt: expiryIso() };
  if (hasFiles) {
    resp.uploads = entries.map((e, seq) =>
      e.kind === "file"
        ? { seq, uploadUrl: `${origin}/api/upload?job=${jobId}&seq=${seq}`, uploadChunkBytes: limits.UPLOAD_CHUNK_BYTES }
        : { seq, uploadUrl: null }
    );
  }
  return resp;
}

// تنفيذ الدمج الكامل (متزامن، يستغرق ثوانٍ إلى دقائق حسب الحجم)
async function processJob(jobId) {
  await store.purgeExpired();
  const job = await store.getJob(jobId);
  if (!job) throw Object.assign(new Error("المهمة غير موجودة"), { statusCode: 404 });
  if (job.status === "done") {
    return { done: true, alreadyDone: true };
  }
  if (job.status === "processing") {
    throw Object.assign(new Error("المهمة قيد المعالجة بالفعل"), { statusCode: 202 });
  }
  if (job.status === "failed") {
    throw Object.assign(new Error(`المهمة فشلت سابقًا: ${job.error || "غير معروف"}`), { statusCode: 409 });
  }
  // uploading: تأكد أن كل الملفات اكتمل رفعها
  const sources = await store.listSources(jobId);
  for (const s of sources) {
    if (s.kind === "file" && Number(s.uploaded || 0) <= 0) {
      throw Object.assign(new Error(`مصدر الملف رقم ${s.seq} لم يُرفع بعد`), { statusCode: 409 });
    }
  }
  await store.updateJob(jobId, { status: "processing", progress: 3 });
  try {
    const info = await runMergeJob(jobId, { store, onProgress: () => {} });
    return { done: true, ...info };
  } catch (e) {
    await store.updateJob(jobId, { status: "failed", error: String(e.message || e).slice(0, 500), progress: 0 });
    throw e;
  }
}

// حالة مهمة للعرض — تحليل دفاعي مثل عميل MCP
function jobStatusPayload(job, origin) {
  const urls = publicUrls(String(job.id), origin);
  const out = {
    jobId: String(job.id),
    status: String(job.status),
    progress: Number(job.progress || 0),
    expiresAt: job.expires_at,
    videoUrl: urls.videoUrl,
    downloadUrl: urls.downloadUrl,
  };
  if (job.status === "done") {
    out.size = Number(job.video_size || 0);
    out.duration = Number(job.video_duration || 0);
    out.resolution = job.video_resolution || "";
  }
  if (job.status === "failed") out.error = job.error || "فشل غير معروف";
  return out;
}

async function deleteJob(jobId) {
  const job = await store.getJob(jobId);
  if (!job) throw Object.assign(new Error("المهمة غير موجودة"), { statusCode: 404 });
  await store.deleteJobCompletely(jobId);
}

module.exports = { createJobFromPayload, processJob, jobStatusPayload, deleteJob, publicUrls, originFromReq, validPublicUrl, expiryIso, newJobId };

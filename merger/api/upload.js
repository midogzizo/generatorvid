// POST /api/upload?job=<id>&seq=<n> — رفع أجزاء ثنائية (≤4MB، Content-Type: application/octet-stream)
// الأجزاء تُلحق بترتيب الوصول، وكل 4MB تُقسم داخليًا صفوفًا 2MB لأن حد HTTP في Turso.
const store = require("../lib/db");
const { sendJson, sendError, readBodyBuffer } = require("../lib/httpx");
const limits = require("../lib/limits");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") return sendError(res, 405, "استخدم POST لرفع الأجزاء");
  const jobId = String(req.query.job || "");
  const seq = Number(req.query.seq);
  if (!jobId || !Number.isInteger(seq) || seq < 0) {
    return sendError(res, 400, "معطيات job و seq مطلوبة");
  }
  try {
    const job = await store.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة");
    if (job.status !== "uploading" && job.status !== "queued") {
      return sendError(res, 409, `لا يمكن الرفع في الحالة الحالية (${job.status})`);
    }
    const sources = await store.listSources(jobId);
    const src = sources.find((s) => Number(s.seq) === seq);
    if (!src) return sendError(res, 404, "المصدر غير موجود في هذه المهمة");
    if (src.kind !== "file") return sendError(res, 409, "المصدر رابط URL — لا يحتاج رفعًا");

    const buf = await readBodyBuffer(req, limits.UPLOAD_CHUNK_BYTES + 512 * 1024);
    if (!buf.length) return sendError(res, 400, "جسم الطلب فارغ");
    if (Number(src.size || 0) > 0 && Number(src.uploaded || 0) + buf.length > Number(src.size)) {
      return sendError(res, 413, "الحجم المرفوع يتجاوز حجم الملف المعلن");
    }
    await store.appendSourceChunk(jobId, seq, buf);

    // اكتمال كل ملفات المصادر → queued
    const after = await store.listSources(jobId);
    const allUploaded = after.every((s) => s.kind === "url" || Number(s.uploaded || 0) >= Number(s.size || 1));
    if (allUploaded && job.status === "uploading") {
      await store.updateJob(jobId, { status: "queued" });
    }
    return sendJson(res, 200, {
      ok: true,
      job: jobId,
      seq,
      uploadedBytes: Number(src.uploaded || 0) + buf.length,
      status: allUploaded && job.status === "uploading" ? "queued" : "uploading",
    });
  } catch (e) {
    const status = e.statusCode || 500;
    if (status === 500) console.error("[api/upload]", e);
    return sendError(res, status, e.message || "فشل الرفع");
  }
};

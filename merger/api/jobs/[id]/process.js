// POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن) ثم رابط الناتج
const { processJob, publicUrls, originFromReq } = require("../../../lib/jobs");
const store = require("../../../lib/db");
const { sendJson, sendError } = require("../../../lib/httpx");
const limits = require("../../../lib/limits");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") return sendError(res, 405, "استخدم POST لتنفيذ الدمج");
  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرّف المهمة مطلوب");
  try {
    const result = await processJob(String(jobId));
    const job = await store.getJob(String(jobId));
    const urls = publicUrls(String(jobId), originFromReq(req));
    const expiryIso = job?.expires_at;
    return sendJson(res, 200, {
      status: "done",
      videoUrl: urls.videoUrl,
      downloadUrl: urls.downloadUrl,
      size: result.size,
      duration: Number(result.duration?.toFixed?.(2) ?? 0),
      resolution: result.resolution,
      expiresAt: expiryIso,
    });
  } catch (e) {
    const status = e.statusCode || 500;
    if (status === 202) {
      // قيد المعالجة بالفعل — استجابة غير نهائية
      return sendJson(res, 202, { status: "processing" });
    }
    if (status === 500) console.error("[api/jobs/:id/process]", e);
    return sendError(res, status, e.message || "فشل الدمج");
  }
};

// تذكير: maxDuration يُضبط من vercel.json
void limits;

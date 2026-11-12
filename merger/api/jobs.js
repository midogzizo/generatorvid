// POST /api/jobs — إنشاء مهمة دمج | GET — قائمة أحدث المهام
const store = require("../lib/db");
const { createJobFromPayload, originFromReq } = require("../lib/jobs");
const { sendJson, sendError, readJsonBody } = require("../lib/httpx");

module.exports = async function handler(req, res) {
  // CORS مفتوح للواجهة البرمجية العامة
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method === "POST") {
      const payload = await readJsonBody(req);
      const resp = await createJobFromPayload(payload, originFromReq(req));
      return sendJson(res, 201, resp);
    }
    if (req.method === "GET") {
      const jobs = await store.listJobs(20);
      return sendJson(res, 200, { jobs: jobs.map((j) => ({ jobId: j.id, status: j.status, progress: j.progress, createdAt: j.created_at, expiresAt: j.expires_at })) });
    }
    return sendError(res, 405, "طريقة الطلب غير مدعومة");
  } catch (e) {
    const status = e.statusCode || (String(e.message).includes("غير موجود") ? 404 : 500);
    if (status === 500) console.error("[api/jobs]", e);
    return sendError(res, status, e.message || "خطأ غير متوقع");
  }
};

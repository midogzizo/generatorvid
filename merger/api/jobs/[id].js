// GET /api/jobs/<id> — الحالة والتقدم | DELETE — حذف فوري شامل
const store = require("../../lib/db");
const { jobStatusPayload, deleteJob, originFromReq } = require("../../lib/jobs");
const { sendJson, sendError } = require("../../lib/httpx");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرّف المهمة مطلوب");
  try {
    if (req.method === "GET") {
      const job = await store.getJob(String(jobId));
      if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
      return sendJson(res, 200, jobStatusPayload(job, originFromReq(req)));
    }
    if (req.method === "DELETE") {
      await deleteJob(String(jobId));
      return sendJson(res, 200, { ok: true, deleted: String(jobId) });
    }
    return sendError(res, 405, "طريقة الطلب غير مدعومة");
  } catch (e) {
    const status = e.statusCode || 500;
    if (status === 500) console.error("[api/jobs/:id]", e);
    return sendError(res, status, e.message || "خطأ غير متوقع");
  }
};

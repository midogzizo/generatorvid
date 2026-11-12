// GET /api/cron — حذف المهام المنتهية (Cron يومي عبر vercel.json)
const store = require("../lib/db");
const { sendJson, sendError } = require("../lib/httpx");

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return sendError(res, 405, "طريقة غير مدعومة");
  try {
    const n = await store.purgeExpired();
    return sendJson(res, 200, { ok: true, purged: n });
  } catch (e) {
    console.error("[api/cron]", e);
    return sendError(res, 500, e.message || "فشل التنظيف");
  }
};

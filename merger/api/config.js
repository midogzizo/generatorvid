// GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية في /api/health بالمشروع الآخر)
const limits = require("../lib/limits");
const { sendJson } = require("../lib/httpx");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  return sendJson(res, 200, {
    version: "2.0.0",
    maxSources: limits.MAX_SOURCES,
    sourceMaxMB: limits.SOURCE_MAX_MB,
    outputMaxMB: limits.OUTPUT_MAX_MB,
    maxTotalDurationSec: limits.MAX_TOTAL_DURATION_SEC,
    uploadChunkBytes: limits.UPLOAD_CHUNK_BYTES,
    expiryHours: limits.EXPIRY_HOURS,
    output: "mp4 (H.264 + AAC) — even up to 1080p, CRF 18 — no resolution/fps parameters",
  });
};

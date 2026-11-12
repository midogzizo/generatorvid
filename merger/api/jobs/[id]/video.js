// GET /api/jobs/<id>/video — بث الناتج بدعم Range (206 + Content-Range) و ?download=1
// يقرأ صفوف الـ Blobs من Turso ويقليم أول/آخر جزء حسب المدى المطلوب.
const store = require("../../../lib/db");
const { sendError } = require("../../../lib/httpx");

module.exports = async function handler(req, res) {
  const jobId = req.query.id;
  if (!jobId) return sendError(res, 400, "معرّف المهمة مطلوب");
  try {
    const job = await store.getJob(String(jobId));
    if (!job) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    if (job.status !== "done") {
      return sendError(res, 409, `الناتج غير جاهز بعد (الحالة: ${job.status})`);
    }
    const total = await store.totalBytes("output_chunks", String(jobId));
    if (total === 0) return sendError(res, 404, "لا يوجد ناتج مخزن لهذه المهمة");

    // تحليل ترويسة Range — نرضى مدى واحد bytes=start-end (نهاية مفتوحة/سالبة)
    let start = 0, end = total - 1, partial = false;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] !== "" || m[2] !== "")) {
        partial = true;
        if (m[1] === "") {
          // آخر N بايت
          const n = Number(m[2]);
          start = Math.max(0, total - n);
          end = total - 1;
        } else {
          start = Number(m[1]);
          end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
        }
        if (start > end || start >= total) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` });
          return res.end();
        }
      }
    }

    const headers = {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    };
    if (req.query.download === "1" || req.query.download === "true") {
      headers["Content-Disposition"] = `attachment; filename="merged-${jobId}.mp4"`;
    }

    // تجميع المدى المطلوب من صفوف 2MB (المدايات الكبيرة تُقرأ صفحات)
    const CHUNK = 4 * 1024 * 1024; // نرسل بقطع ≤4MB داخل المدى لضبط الذاكرة
    if (partial) {
      headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
      headers["Content-Length"] = String(end - start + 1);
      res.writeHead(206, headers);
    } else {
      headers["Content-Length"] = String(total);
      res.writeHead(200, headers);
    }

    let pos = start;
    const storeRef = store;
    while (pos <= end) {
      const segEnd = Math.min(pos + CHUNK - 1, end);
      const buf = await storeRef.readOutputRange(String(jobId), pos, segEnd);
      if (!buf) break;
      if (!res.write(buf)) {
        await new Promise((r) => res.once("drain", r));
      }
      pos = segEnd + 1;
    }
    res.end();
  } catch (e) {
    console.error("[api/jobs/:id/video]", e);
    if (!res.headersSent) return sendError(res, 500, e.message || "خطأ في البث");
    res.destroy();
  }
};

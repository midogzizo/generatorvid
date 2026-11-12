// مساعدات HTTP مشتركة: ردود JSON، قراءة جسم ثنائي بحد حجم، وأخطاء بصيغة موحدة
function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// قراءة الجسم كـ Buffer مع حد أقصى — يتجاوزه → 413
function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("حجم الطلب يتجاوز الحد المسموح"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// قراءة جسم JSON مع رفض التالف → 400
async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const buf = await readBodyBuffer(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON تالف في جسم الطلب"), { statusCode: 400 });
  }
}

module.exports = { sendJson, sendError, readBodyBuffer, readJsonBody };

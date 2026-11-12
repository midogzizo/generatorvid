// خادم تطوير محلي يحاكي بيئة Vercel: يحلّل المسارات الديناميكية ويضعها في req.query
// التشغيل: node scripts/dev.js (بورق 8787)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

// تحميل .env يدويًا (بدون اعتماديات خارجية)
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PORT = Number(process.env.PORT || 8787);

// جدول المسارات مع الاستخراج الديناميكي
const routes = [
  { re: /^\/api\/jobs\/([^/]+)\/process$/, file: "api/jobs/[id]/process.js", key: "id" },
  { re: /^\/api\/jobs\/([^/]+)\/video$/, file: "api/jobs/[id]/video.js", key: "id" },
  { re: /^\/api\/jobs\/([^/]+)$/, file: "api/jobs/[id].js", key: "id" },
  { re: /^\/api\/jobs$/, file: "api/jobs.js" },
  { re: /^\/api\/upload$/, file: "api/upload.js" },
  { re: /^\/api\/config$/, file: "api/config.js" },
  { re: /^\/api\/cron$/, file: "api/cron.js" },
];

const ROOT = path.join(__dirname, "..");

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    // فك المسار الديناميكي إلى req.query (محاكاة Vercel)
    for (const r of routes) {
      const m = r.re.exec(u.pathname);
      if (m) {
        if (r.key) req.query = { ...Object.fromEntries(u.searchParams), [r.key]: decodeURIComponent(m[1]) };
        else req.query = Object.fromEntries(u.searchParams);
        const handler = require(path.join(ROOT, r.file));
        return await handler(req, res);
      }
    }
    // ملفات ثابتة من public/
    let p = u.pathname === "/" ? "/index.html" : u.pathname;
    const file = path.join(ROOT, "public", path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "غير موجود" }));
  } catch (e) {
    console.error("[dev]", e);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message || "خطأ غير متوقع" }));
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Video Merger dev server → http://localhost:${PORT}  (يحاكي بيئة Vercel)`);
});

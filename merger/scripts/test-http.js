// اختبار HTTP كامل ضد خادم التطوير:
// إنشاء مهمة من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع) → حذف → 404 → JSON تالف → قائمة فارغة
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const BASE = process.env.TEST_BASE || "http://localhost:8787";

function abs(u) { return /^https?:\/\//i.test(u) ? u : BASE + u; }

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

function ffmpeg(args) {
  const r = spawnSync(require("ffmpeg-static"), args, { timeout: 120000 });
  if (r.status !== 0) throw new Error("ffmpeg failed: " + r.stderr.toString().slice(-200));
}

async function jfetch(path, opts) {
  const res = await fetch(BASE + path, opts);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, res };
}

async function main() {
  // مقطعان عامان حسب معايير القبول (يصلحان للتحميل العام)
  const A = "https://www.w3schools.com/html/mov_bbb.mp4";
  const B = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";

  console.log("== 1) إنشاء مهمة من روابط → دمج → بث Range");
  let { status, json } = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: [A, B] }) });
  check("POST /api/jobs → 201", status === 201, `got ${status}`);
  check("الاستجابة jobId/status/statusUrl/processUrl/expiresAt", json && json.jobId && json.status === "queued" && json.statusUrl && json.processUrl && json.expiresAt);
  const jobId = json.jobId;

  ({ status, json } = await jfetch(`/api/jobs/${jobId}/process`, { method: "POST" }));
  check("POST process → 200 done", status === 200 && json?.status === "done", `${status} ${JSON.stringify(json).slice(0, 120)}`);
  check("videoUrl/downloadUrl/size/duration/resolution موجودة", json?.videoUrl && json?.downloadUrl && json?.size > 0 && json?.duration > 0 && /x/.test(json?.resolution || ""));
  check("الدقة صحيحة للناتج", /^\d+x\d+$/.test(json.resolution), json.resolution);

  // بث كامل + Range
  let vres = await fetch(abs(json.videoUrl));
  check("GET video → 200 مع Accept-Ranges", vres.status === 200 && vres.headers.get("accept-ranges") === "bytes");
  const fullBuf = Buffer.from(await vres.arrayBuffer());
  check("حجم البث = الحجم المعلن", fullBuf.length === json.size, `${fullBuf.length} vs ${json.size}`);

  vres = await fetch(abs(json.videoUrl), { headers: { Range: "bytes=100-999" } });
  const part = Buffer.from(await vres.arrayBuffer());
  check("Range → 206 + Content-Range", vres.status === 206 && String(vres.headers.get("content-range")).startsWith(`bytes 100-999/${json.size}`));
  check("الجزء متطابق مع البث الكامل", part.length === 900 && Buffer.compare(part, fullBuf.subarray(100, 1000)) === 0);
  const shaFull = crypto.createHash("sha256").update(fullBuf).digest("hex");

  // النطاق على خدمة الدمج نفسها — لا نطاق داخلي في الرابط
  const u = new URL(json.videoUrl);
  check("الرابط على نطاق الخدمة نفسها (عام)", u.origin === BASE);

  console.log("== 2) مهمة مختلطة (رابط + ملف مرفوع بأجزاء)");
  // توليد ملف محلي صغير لرفعه
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "httptest-"));
  const local = path.join(tmp, "local.mp4");
  ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", local]);
  const fileBuf = fs.readFileSync(local);
  ({ status, json } = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sources: [{ kind: "url", url: A }, { kind: "file", name: "local.mp4", size: fileBuf.length, mime: "video/mp4" }] }) }));
  check("POST مصادر مختلطة → 201 uploading", status === 201 && json.status === "uploading", `${status}`);
  check("uploads[] برابط رفع لكل مصدر + uploadChunkBytes", Array.isArray(json.uploads) && json.uploads[1].uploadUrl && json.uploads[1].uploadChunkBytes > 0);
  const jobId2 = json.jobId;
  // رفع الملف بأجزاء 4MB مع إعادة المحاولة
  const CHUNK = json.uploads[1].uploadChunkBytes;
  let ok = true;
  for (let off = 0, idx = 0; off < fileBuf.length; off += CHUNK, idx++) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await fetch(abs(json.uploads[1].uploadUrl) + `&chunk=${idx}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: fileBuf.subarray(off, Math.min(fileBuf.length, off + CHUNK)) });
      if (r.ok) { ok = true; break; }
      if (attempt === 3) ok = false;
    }
  }
  check("رفع الأجزاء نجح", ok);
  ({ status, json } = await jfetch(`/api/jobs/${jobId2}/process`, { method: "POST" }));
  check("دمج مختلط → done", status === 200 && json?.status === "done", `${status} ${JSON.stringify(json).slice(0, 120)}`);
  ({ status } = await fetch(abs(json.videoUrl)));
  check("ناتج المهمة المختلطة يُبَث", status === 200);

  console.log("== 3) الحدود والرفض");
  ({ status, json } = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: [A] }) }));
  check("مقطع واحد → 400 برسالة عربية", status === 400 && /مقطع/.test(json?.error || ""));
  const over = Array.from({ length: 11 }, () => A);
  ({ status, json } = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: over }) }));
  check("11 مقطعًا → 400 برسالة عربية", status === 400 && /10/.test(json?.error || ""));
  ({ status, json } = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json-at-all" }));
  check("JSON تالف → 400", status === 400);
  ({ status } = await fetch(BASE + "/api/jobs", { method: "PUT" }));
  check("PUT → 405", status === 405);

  console.log("== 4) الحذف الشامل ثم 404");
  ({ status, json } = await jfetch(`/api/jobs/${jobId}`, { method: "DELETE" }));
  check("DELETE → 200", status === 200 && json?.ok);
  ({ status, json } = await jfetch(`/api/jobs/${jobId}`));
  check("GET بعد الحذف → 404 برسالة عربية", status === 404 && /غير موجودة|24/.test(json?.error || ""));
  ({ status } = await fetch(BASE + `/api/jobs/${jobId}/video`));
  check("video بعد الحذف → 404", status === 404);
  ({ status } = await jfetch(`/api/jobs/${jobId}/process`, { method: "POST" }));
  check("process بعد الحذف → 404", status === 404);

  console.log("== 5) قائمة فارغة + config");
  ({ status, json } = await jfetch("/api/jobs"));
  check("GET /api/jobs يعيد قائمة (مع المهام المتبقية)", status === 200 && Array.isArray(json?.jobs));
  ({ status, json } = await jfetch("/api/config"));
  check("config يعيد الحدود + version", status === 200 && json?.maxSources === 10 && json?.sourceMaxMB === 200 && json?.outputMaxMB === 150 && json?.version);
  ({ status, json } = await jfetch("/api/cron"));
  check("cron يعمل", status === 200 && typeof json?.purged === "number");

  // تنظيف المهمة المختلطة
  await jfetch(`/api/jobs/${jobId2}`, { method: "DELETE" });
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

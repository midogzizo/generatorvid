// اختبار وحدات محرك الدمج: يولّد فيديوهين مختلفي الدرة بـ ffmpeg، يدمجهما عبر نفس مكتبة المشروع،
// ويتحقق: اكتمال الدمج، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت.
// ثم يختبر التخزين في Turso والاسترجاع بتطابق sha256، مسار رفع الأجزاء، حدود الحجم، والحذف الشامل.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// تحميل .env يدويًا مثل dev.js
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const store = require("../lib/db");
const { probeFile, ffmpegPath, buildFilterChain } = require("../lib/merge");
const limits = require("../lib/limits");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

function ffmpeg(args) {
  const r = spawnSync(ffmpegPath(), args, { timeout: 180000 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString().slice(-300)}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mergtest-"));
  console.log("== 1) توليد فيديوهين مختلفي الدقة بـ ffmpeg");
  const clip1 = path.join(tmp, "c1.mp4"); // 640x360 مع صوت، 4 ثوان
  const clip2 = path.join(tmp, "c2.mp4"); // 1280x720 بدون صوت، 3 ثوان
  ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip1]);
  ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=duration=3:size=1280x720:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip2]);
  const p1 = await probeFile(clip1);
  const p2 = await probeFile(clip2);
  check("probe1: 640x360 مع صوت", p1.width === 640 && p1.height === 360 && p1.hasAudio);
  check("probe2: 1280x720 بلا صوت", p2.width === 1280 && p2.height === 720 && !p2.hasAudio);

  console.log("== 2) بناء filter_complex (توحيد + صامت)");
  const { filter, W, H } = buildFilterChain([p1, p2]);
  check("الأبعاد = أكبر دقة مدخل (1280x720 زوجية)", W === 1280 && H === 720, `${W}x${H}`);
  check("السلسلة تتضمن concat", /concat=n=2:v=1:a=1/.test(filter));
  check("السلسلة تتضمن anullsrc-split للمصدر الصامت", /asplit=1/.test(filter));
  check("السلسلة تتضمن fps=30 و yuv420p", /fps=30/.test(filter) && /format=yuv420p/.test(filter));

  console.log("== 3) دمج فعلي بنفس منطق الخدمة");
  const outFile = path.join(tmp, "out.mp4");
  const n = 2;
  const args = ["-y", "-i", clip1, "-i", clip2];
  args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  args.push("-filter_complex", filter, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-movflags", "+faststart", outFile);
  ffmpeg(args);
  const merged = await probeFile(outFile);
  check("اكتمال الدمج", fs.statSync(outFile).size > 0);
  check("دقة الناتج = أكبر دقة مدخل", merged.width === 1280 && merged.height === 720, `${merged.width}x${merged.height}`);
  const dur = merged.duration;
  const sum = p1.duration + p2.duration;
  check("المدة ≈ مجموع المدد (±0.5s)", Math.abs(dur - sum) < 0.5, `${dur.toFixed(2)} vs ${sum.toFixed(2)}`);
  check("وجود صوت في الناتج", merged.hasAudio);
  check("fps = 30", Math.abs(merged.fps - 30) < 0.01, String(merged.fps));

  console.log("== 4) التخزين في Turso والاسترجاع بتطابق sha256");
  const jobId = "unittest-" + crypto.randomBytes(3).toString("hex");
  await store.insertJob({ id: jobId, status: "done", expires_at: store.nowUtc() });
  const buf = fs.readFileSync(outFile);
  const shaIn = crypto.createHash("sha256").update(buf).digest("hex");
  await store.appendOutputChunks(jobId, buf);
  const round = await store.readOutputRange(jobId, 0, buf.length - 1);
  const shaOut = crypto.createHash("sha256").update(round).digest("hex");
  check("sha256 متطابق بعد التخزين والاسترجاع", shaIn === shaOut);
  const total = await store.totalBytes("output_chunks", jobId);
  check("الحجم المخزن صحيح", total === buf.length);

  console.log("== 5) استرجاع مدى (Range) جزئي بتطابق sha256");
  const sliceStart = 1024 * 100, sliceEnd = 1024 * 100 + 5000;
  const slice = await store.readOutputRange(jobId, sliceStart, sliceEnd);
  const shaSlice = crypto.createHash("sha256").update(slice).digest("hex");
  const shaExpect = crypto.createHash("sha256").update(buf.subarray(sliceStart, sliceEnd + 1)).digest("hex");
  check("Range جزئي متطابق", shaSlice === shaExpect && slice.length === sliceEnd - sliceStart + 1);

  console.log("== 6) مسار رفع الأجزاء (appendSourceChunk) والحدود");
  await store.insertSource(jobId, 0, { kind: "file", name: "f1", size: 9 * 1024 * 1024, mime: "video/mp4" });
  const big = Buffer.alloc(4.5 * 1024 * 1024, 7); // جزء رفع 4.5MB → يُقسم صفوفين 2MB+2.5MB
  await store.appendSourceChunk(jobId, 0, big);
  const back = await store.readSourceBytes(jobId, 0);
  check("تجميع الأجزاء المرفوعة متطابق", Buffer.compare(back, big) === 0, `${back.length} vs ${big.length}`);
  const srcTotal = await store.totalBytes("source_chunks", jobId);
  check("الحجم المرفوع مسجل", Number(srcTotal) === big.length);

  console.log("== 7) حدود الحجم (رفض تجاوز حد المصدر عبر المنطق)");
  check("حد SOURCE_MAX_MB مضبوط", limits.SOURCE_MAX_MB === 200, String(limits.SOURCE_MAX_MB));
  check("حد OUTPUT_MAX_MB مضبوط", limits.OUTPUT_MAX_MB === 150, String(limits.OUTPUT_MAX_MB));

  console.log("== 8) الحذف الشامل");
  await store.deleteJobCompletely(jobId);
  const gone = await store.getJob(jobId);
  const outCount = await store.totalBytes("output_chunks", jobId);
  const srcCount = await store.totalBytes("source_chunks", jobId);
  check("المهمة محذوفة", !gone);
  check("صفوف الناتج محذوفة", outCount === 0);
  check("صفوف المصادر محذوفة", srcCount === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

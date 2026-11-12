// محرك الدمج — ffmpeg داخل الدالة نفسها بجودة عالية إلزامية
// توحيد كل المصادر: scale+pad لأكبر دقة (حد 1920×1080، أبعاد زوجية)، fps=30، setsar=1، format=yuv420p
// ثم concat=n=:v=1:a=1. مصدر بلا صوت → مسار صامت anullsrc بنفس مدته بدل فشل الدمج.
// الترميز: libx264 CRF 18 + AAC 192k/44100 + faststart. التقدم من -progress pipe:1 (out_time_us).
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const limits = require("./limits");

const FFMPEG_BIN = require("ffmpeg-static");
const FFPROBE_BIN = require("ffprobe-static").path;

// ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة — ننسخه إلى /tmp بصلاحية 755 عند الحاجة
const prepared = {};
function ensureExecutable(src, name) {
  const dest = path.join(os.tmpdir(), name);
  if (!prepared[name]) {
    try {
      fs.accessSync(dest, fs.constants.X_OK);
    } catch {
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
    }
    prepared[name] = dest;
  }
  return dest;
}
function ffmpegPath() { return ensureExecutable(FFMPEG_BIN, "ffmpeg-merger"); }
function ffprobePath() { return ensureExecutable(FFPROBE_BIN, "ffprobe-merger"); }

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("انتهت مهلة العملية")); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// تحليل ffprobe: الدقة، fps، المدة، وجود صوت
async function probeFile(file) {
  const { code, out, err } = await run(ffprobePath(), [
    "-v", "error", "-print_format", "json",
    "-show_streams", "-show_format", file,
  ], 120000);
  if (code !== 0) throw new Error(`فشل تحليل المصدر: ${err.slice(0, 200)}`);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("المصدر لا يحتوي مسار فيديو");
  const num = Number(v.avg_frame_rate?.split("/")[0] || 0);
  const den = Number(v.avg_frame_rate?.split("/")[1] || 0);
  const fps = den > 0 && num > 0 ? num / den : Number(v.r_frame_rate?.split("/")[0] || 30);
  return {
    width: v.width,
    height: v.height,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    duration: Number(j.format?.duration || v.duration || 0),
    hasAudio: Boolean(a),
  };
}

// تنزيل مصدر URL إلى /tmp مع عدّ بايتات ضد حد الحجم
async function downloadSource(url, destFile, maxBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`فشل تنزيل المصدر (HTTP ${res.status})`);
  const writer = fs.createWriteStream(destFile);
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      writer.destroy();
      fs.rmSync(destFile, { force: true });
      throw new Error(`حجم المصدر يتجاوز الحد (${limits.SOURCE_MAX_MB}MB)`);
    }
    if (!writer.write(chunk)) await new Promise((r) => writer.once("drain", r));
  }
  writer.end();
  await new Promise((r) => writer.on("close", r));
  return total;
}

// تجميع مصدر مرفوع من صفوف Turso إلى ملف في /tmp
async function assembleSource(store, jobId, seq, destFile) {
  const buf = await store.readSourceBytes(jobId, seq);
  fs.writeFileSync(destFile, buf);
  return buf.length;
}

// بناء filter_complex كامل
function buildFilterChain(inputs) {
  const n = inputs.length;
  const maxW = Math.max(...inputs.map((i) => i.width));
  const maxH = Math.max(...inputs.map((i) => i.height));
  // حد أقصى 1920×1080 وأبعاد زوجية
  let W = Math.min(maxW, 1920), H = Math.min(maxH, 1080);
  if (W % 2) W -= 1;
  if (H % 2) H -= 1;
  const silentIdx = inputs.filter((i) => !i.hasAudio).length;
  const parts = [];
  // صامت واحد مشترك مع asplit عند الحاجة لمصادر بلا صوت
  const SILENT = n; // فهرس مدخل anullsrc
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    if (inputs[i].hasAudio) {
      parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
  }
  if (silentIdx > 0) {
    // توزيع الصامت على المصادر بلا صوت مع قصّ كل مقطع إلى مدته
    const splitLabels = Array.from({ length: silentIdx }, (_, k) => `s${k}`).join("][");
    parts.push(`[${SILENT}:a]asplit=${silentIdx}[${splitLabels}]`);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (!inputs[i].hasAudio) {
        parts.push(`[s${k}]atrim=duration=${inputs[i].duration.toFixed(3)},asetpts=N/SR/TB[a${i}]`);
        k++;
      }
    }
  }
  const concat = `${inputs.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${n}:v=1:a=1[vout][aout]`;
  parts.push(concat);
  return { filter: parts.join(";"), W, H };
}

// الدمج الكامل: تنزيل/تجميع → تحليل → ترميز → تحقق الحدود → تخزين الناتج
async function runMergeJob(jobId, opts) {
  const { store, baseOrigin, onProgress } = opts;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
  const files = [];
  try {
    const sources = await store.listSources(jobId);
    if (sources.length < 2) throw new Error("الدمج يحتاج مقطعَين على الأقل");
    const inputs = [];
    const totalDurLimit = limits.MAX_TOTAL_DURATION_SEC;
    let totalDuration = 0;
    for (const s of sources) {
      const seq = Number(s.seq);
      const f = path.join(tmpDir, `src-${seq}.mp4`);
      if (s.kind === "url") {
        await downloadSource(s.url, f, limits.SOURCE_MAX_MB * 1024 * 1024);
      } else {
        const size = await assembleSource(store, jobId, seq, f);
        if (size > limits.SOURCE_MAX_MB * 1024 * 1024) {
          throw new Error(`حجم المصدر ${s.name || seq} يتجاوز الحد (${limits.SOURCE_MAX_MB}MB)`);
        }
      }
      files.push(f);
      const meta = await probeFile(f);
      if (meta.duration <= 0) throw new Error(`مدة المصدر ${seq} غير صالحة`);
      totalDuration += meta.duration;
      if (totalDuration > totalDurLimit) {
        throw new Error(`مجموع مدد المقاطع يتجاوز ${totalDurLimit} ثانية`);
      }
      inputs.push(meta);
      const pct = 5 + Math.round(((seq + 1) / sources.length) * 35); // 0–40 سحب المصادر
      await store.updateJob(jobId, { progress: Math.min(pct, 40) });
      onProgress && onProgress(Math.min(pct, 40));
    }

    // أطوال المسارات الصامتة تحتاج المدة من probeFile — بناء السلسلة
    const { filter, W, H } = buildFilterChain(inputs);
    const outFile = path.join(tmpDir, "out.mp4");
    const args = ["-y"];
    for (const f of files) args.push("-i", f);
    if (inputs.some((i) => !i.hasAudio)) {
      args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    }
    args.push(
      "-filter_complex", filter,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", limits.FFMPEG_PRESET, "-crf", "18",
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
      "-movflags", "+faststart",
      "-progress", "pipe:1", "-nostats",
      outFile
    );

    await store.updateJob(jobId, { progress: 42 });
    onProgress && onProgress(42);

    // تشغيل الترميز مع قراءة التقدم من stdout
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      const totalOut = inputs.reduce((a, b) => a + b.duration, 0);
      p.stdout.on("data", (d) => {
        const text = d.toString();
        const m = text.match(/out_time_us=(\d+)/);
        if (m) {
          const sec = Number(m[1]) / 1_000_000;
          const pct = 40 + Math.round((sec / Math.max(totalOut, 0.1)) * 50); // 40–90 ترميز
          if (pct >= 41 && pct <= 90) {
            store.updateJob(jobId, { progress: pct }).catch(() => {});
            onProgress && onProgress(pct);
          }
        }
      });
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`فشل ترميز ffmpeg (رمز ${code}): ${err.slice(-400)}`))));
      p.on("error", reject);
    });

    const size = fs.statSync(outFile).size;
    if (size > limits.OUTPUT_MAX_MB * 1024 * 1024) {
      throw new Error(`حجم الناتج يتجاوز الحد (${limits.OUTPUT_MAX_MB}MB)`);
    }

    // تخزين الناتج كصفوف 2MB ثم حذف أجزاء المصادر — الناتج فقط هو المطلوب
    const buf = fs.readFileSync(outFile);
    await store.updateJob(jobId, { progress: 92 });
    onProgress && onProgress(92);
    await store.appendOutputChunks(jobId, buf);
    await store.deleteSourceChunks(jobId);
    await store.updateJob(jobId, {
      status: "done",
      progress: 100,
      video_size: size,
      video_duration: Number(totalDuration.toFixed(2)),
      video_resolution: `${W}x${H}`,
    });
    onProgress && onProgress(100);
    return { size, duration: totalDuration, resolution: `${W}x${H}` };
  } finally {
    // نظّف /tmp دائمًا — لا اعتماد على ملفات محلية دائمة
    for (const f of files) fs.rmSync(f, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { runMergeJob, probeFile, buildFilterChain, ffmpegPath, ffprobePath };

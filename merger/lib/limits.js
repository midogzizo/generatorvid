// حدود الخدمة القابلة للضبط بمتغيرات البيئة
module.exports = {
  MAX_SOURCES: Number(process.env.MAX_SOURCES || 10),
  SOURCE_MAX_MB: Number(process.env.SOURCE_MAX_MB || 200),
  OUTPUT_MAX_MB: Number(process.env.OUTPUT_MAX_MB || 150),
  MAX_TOTAL_DURATION_SEC: Number(process.env.MAX_TOTAL_DURATION_SEC || 600),
  FFMPEG_PRESET: process.env.FFMPEG_PRESET || "medium",
  // حجم جزء الرفع من الواجهة — أقل من حد الطلب في Vercel (~4.5MB)
  UPLOAD_CHUNK_BYTES: 4 * 1024 * 1024,
  EXPIRY_HOURS: 24,
};

# Video Merger API v2 — خدمة دمج مقاطع الفيديو

خدمة دمج فيديو كاملة: واجهة عربية RTL + واجهة برمجية عامة للمطورين، جاهزة للنشر على Vercel.
**Node.js خالص (CommonJS) بلا خطوة بناء** — ffmpeg داخل الدالة نفسها، وكل التخزين في Turso (لا S3 ولا خدمات خارجية).

- **الناتج:** MP4 عالي الجودة (H.264 CRF 18 + AAC 192k/44100) — حتى 1080p بجودة ثابتة، **لا توجد معاملات resolution/fps** — الناتج مثبت.
- **الحدود:** 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد.
- **الصلاحية:** كل الملفات تُحذف تلقائيًا بعد **24 ساعة** (`expiresAt` في الاستجابات).

## النشر على Vercel خطوة بخطوة

1. أنشئ قاعدة Turso وتوكنها:
   ```bash
   turso db create <name>
   turso db show <name> --url      # ← TURSO_DATABASE_URL
   turso db tokens create <name>   # ← TURSO_AUTH_TOKEN
   ```
2. اربط المستودع بـ Vercel واضبط **Root Directory = `merger`**.
3. أضف متغيري البيئة الإلزاميين في Settings → Environment Variables:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
4. Deploy — الجداول تُنشأ تلقائيًا عند أول استخدام، ويُضبط `maxDuration=300` من `vercel.json`، والـ Cron اليومي ينظّف المهام المنتهية عبر `/api/cron` (الثالثة فجرًا).

## توثيق API (بلا تسجيل دخول، CORS مفتوح، الأخطاء بصيغة `{"error":"..."}`)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا → رابط الفيديو النهائي |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range، و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل |
| `GET` | `/api/jobs` | قائمة أحدث المهام |
| `GET` | `/api/config` | الحدود العامة + version |
| `GET` | `/api/cron` | حذف المهام المنتهية (يُجدول أيضًا في vercel.json) |

### 1) إنشاء مهمة

```bash
# من روابط مباشرة
curl -X POST https://<domain>/api/jobs -H 'Content-Type: application/json' \
  -d '{"videos":["https://example.com/clip1.mp4","https://example.com/clip2.mp4"]}'

# أو مزيج روابط + ملفات سيُرفَع لاحقًا
curl -X POST https://<domain>/api/jobs -H 'Content-Type: application/json' \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"b.mp4","size":123456,"mime":"video/mp4"}]}'
```

استجابة `201`:

```json
{
  "jobId": "wkucdefoxwvd",
  "status": "queued",
  "statusUrl": "https://<domain>/api/jobs/wkucdefoxwvd",
  "processUrl": "https://<domain>/api/jobs/wkucdefoxwvd/process",
  "expiresAt": "2026-11-13 23:30:00"
}
```

وإن وُجدت ملفات: `status:"uploading"` + `uploads[]` برابط رفع لكل مصدر و`uploadChunkBytes`.

### 2) رفع ملف من الجهاز (أجزاء 4MB)

```bash
curl -X POST "https://<domain>/api/upload?job=<id>&seq=1&chunk=0" \
  -H 'Content-Type: application/octet-stream' --data-binary @part0.bin
```

اقسم الملف محليًا إلى أجزاء ≤4MB (حد طلب Vercel ≈ 4.5MB) وأرسلها بالترتيب مع `chunk=<k>`. عند اكتمال كل الملفات تعود المهمة إلى `queued`.

### 3) تنفيذ الدمج

```bash
curl -X POST https://<domain>/api/jobs/<id>/process
```

استجابة `200` مباشرة (العملية متزامنة وتستغرق ~10–15 ثانية للمقاطع الصغيرة):

```json
{
  "status": "done",
  "videoUrl": "https://<domain>/api/jobs/<id>/video",
  "downloadUrl": "https://<domain>/api/jobs/<id>/video?download=1",
  "size": 1234567,
  "duration": 30.2,
  "resolution": "640x360",
  "expiresAt": "2026-11-13 23:30:00"
}
```

الأخطاء: `202` إن كانت قيد المعالجة بالفعل، `409` لحالة غير مناسبة، `404` لغير الموجودة، `500` بجسم `{"error":"..."}` عند فشل الدمج (مثل مصدر يرفض التحميل — فشل حتمي).

### 4) متابعة الحالة والناتج

```bash
curl https://<domain>/api/jobs/<id>            # {"jobId","status","progress","videoUrl",...}
curl -H 'Range: bytes=0-1023' https://<domain>/api/jobs/<id>/video   # → 206 + Content-Range
curl -o merged.mp4 "https://<domain>/api/jobs/<id>/video?download=1"
```

حالات المهمة: `queued` → (`uploading`) → `processing` → `done` | `failed`.
التقدم: **0–40** سحب المصادر، **40–90** ترميز ffmpeg، **100** اكتمال.
التقديم/الترجيع في المشغلات يعمل فعلًا لأن البث يدعم Range (206 + Content-Range) من صفوف الـ Blobs في Turso.

### 5) الحذف والتنظيف

```bash
curl -X DELETE https://<domain>/api/jobs/<id>   # حذف شامل: jobs + sources + source_chunks + output_chunks
curl https://<domain>/api/cron                  # تنظيف كل المهام المنتهية (مجدول يوميًا تلقائيًا)
```

بعد نجاح الدمج تُحذف أجزاء المصادر تلقائيًا — الناتج فقط هو المطلوب.

## محرك الدمج (جودة عالية إلزامية)

- `ffprobe` لكل مصدر: الدقة، fps، المدة، وجود صوت.
- توحيد عبر `filter_complex`: `scale` + `pad` إلى **أكبر دقة بين المدخلات** (حد 1920×1080، أبعاد زوجية)، `fps=30`، `setsar=1`، `format=yuv420p` ثم `concat=n=:v=1:a=1`.
- مصدر بلا صوت؟ يُضاف مسار صامت `anullsrc` بنفس مدته بدل فشل الدمج.
- الترميز: `libx264` CRF 18 + `aac` 192k/44100 + `+faststart` — يعمل فورًا على الويب.
- التقدم يُقرأ من `-progress pipe:1` (`out_time_us`) ويُخزَّن في القاعدة.
- `ensureExecutable` تنسخ ثنائي ffmpeg إلى `/tmp` بصلاحية 755 إن فُقد التنفيذ.
- التحقق من الحدود قبل وأثناء العمل — تجاوز أي حد = فشل واضح برسالة عربية، وليس انهيارًا.

## جدول متغيرات البيئة

| المتغير | الافتراضي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | — | **إلزامي** |
| `TURSO_AUTH_TOKEN` | — | **إلزامي** |
| `MERGER_PUBLIC_BASE` | يُشتق من الطلب | ثبّت النطاق العام لروابط statusUrl/videoUrl |
| `MAX_SOURCES` | 10 | أقصى عدد مقاطع |
| `SOURCE_MAX_MB` | 200 | حد كل مصدر |
| `OUTPUT_MAX_MB` | 150 | حد الناتج |
| `MAX_TOTAL_DURATION_SEC` | 600 | مجموع المدد |
| `FFMPEG_PRESET` | medium | preset الترميز |

## الاختبارات

```bash
npm run dev        # خادم تطوير يحاكي Vercel (يحلّل المسارات الديناميكية) على :8787
npm run test:unit  # 21 اختبار: توليد مقطعين مختلفي الدقة بـ ffmpeg → دمج → التحقق من الدقة/المدة/الصوت، Turso + sha256، Range، رفع الأجزاء، الحدود، الحذف
npm run test:http  # 26 اختبار HTTP: روابط → دمج → Range 206 → مهمة مختلطة → حدود → JSON تالف → حذف → 404
```

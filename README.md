# MCP Media Generator + Video Merger

مستودع يحوي **مشروعين** يعملان معًا على Vercel:

| المجلد | المشروع | الوصف |
|---|---|---|
| [`mcp-app/`](./mcp-app) | **MCP Media Generator** (Next.js) | خادم MCP على `/mcp` بخمس أدوات: توليد صور `gpt-image-2-6/flare-text-to-image`، توليد فيديو `grok-imagine-video-1-5-preview`، دمج مقاطع، تتبع المهام، واسترجاع الوسائط — مع **تبديل مفاتيح تسلسلي صارم** (أول مفتاح أُضيف يُجرَّب أولًا) ولوحة إدارة عربية RTL |
| [`merger/`](./merger) | **Video Merger API v2** (Node.js خالص) | خدمة دمج مقاطع عامة للمطورين بـ ffmpeg داخل Serverless، تخزين كامل في Turso، بث MP4 بدعم Range، وحذف تلقائي بعد 24 ساعة — واجهة عربية RTL + [توثيق API كامل](./merger/README.md) |

**المبدأ الجوهري:** لا يُنزَّل أي ملف وسائط على أي سيرفر إطلاقًا — تُخزَّن **روابط النتائج فقط** في قاعدة البيانات.

---

## 1) المتطلبات

- حساب [Turso](https://turso.tech) مجاني (قاعدة + توكن كتابة)
- مفتاح [kie.ai](https://kie.ai) صالح برصيد (وأي مفتاح CometAPI إضافي اختياري)
- حساب Vercel

## 2) إنشاء قاعدة Turso والحصول على التوكن

بالأمر المباشر:

```bash
turso db create media-gen                 # إنشاء القاعدة
turso db show media-gen --url             # TURSO_DATABASE_URL  (الشكل: libsql://<db>-<org>.aws-eu-west-1.turso.io)
turso db tokens create media-gen          # TURSO_AUTH_TOKEN
```

أو من لوحة turso.tech → قاعدة البيانات → **Connect** → انسخ URL و Token.

> ⚠️ **ملاحظة مهمة:** التوكن المُقدَّم مع طلب البناء الأصلي رفضه خادم Turso برسالة
> `invalid JWT token: can't be decoded with any of the existing keys`
> أي أنه صادر لقاعدة أخرى أو أُلغي بعد دوران مفاتيح القاعدة. أنشئ توكنًا جديدًا للقاعدة نفسها كما أعلاه، وسيشتغل كل شيء فورًا — الكود نفسه مُختبَر محليًا مع libSQL ملفي ويستخدم نفس `@libsql/client`.

كلا المشروعين ينشئ جداوله تلقائيًا عند أول استخدام (`CREATE TABLE IF NOT EXISTS`) — لا حاجة لأي أداة migrations، ويمكن للمشروعين مشاركة نفس القاعدة.

## 3) النشر على Vercel خطوة بخطوة

1. ارفع هذا المستودع إلى GitHub (مرفوع مسبقًا على `github.com/midogzizo/generatorvid`).
2. على Vercel: **Add New → Project** → اختر المستودع.
3. في صفحة الإعدادات قبل Deploy: افتح **Root Directory** واضبطه على `merger` → Deploy.
   - أضف متغيرات البيئة (Settings → Environment Variables) لمشروع الدمج:
     | المتغير | القيمة | إلزامي |
     |---|---|---|
     | `TURSO_DATABASE_URL` | رابط Turso | ✅ |
     | `TURSO_AUTH_TOKEN` | توكن Turso | ✅ |
     | `MERGER_PUBLIC_BASE` | `https://<نطاق-الدمج>.vercel.app` (اختياري — يُشتق تلقائيًا من الطلب) | ⬜ |
     | `MAX_SOURCES` / `SOURCE_MAX_MB` / `OUTPUT_MAX_MB` / `MAX_TOTAL_DURATION_SEC` / `FFMPEG_PRESET` | الحدود — الافتراضي 10 / 200 / 150 / 600 / medium | ⬜ |
4. أضف مشروعًا ثانيًا من نفس المستودع: **Root Directory = `mcp-app`** → Deploy.
   - متغيراته:
     | المتغير | القيمة | إلزامي |
     |---|---|---|
     | `TURSO_DATABASE_URL` | رابط Turso | ✅ |
     | `TURSO_AUTH_TOKEN` | توكن Turso | ✅ |
     | `MERGER_API_BASE` | `https://<نطاق-الدمج>.vercel.app` (نطاق مشروع الدمج من الخطوة 3) | ✅ |
     | `MCP_ACCESS_TOKEN` | توكن اختياري يُطلب على `/mcp` كـ Bearer | ⬜ |
5. انسخ نطاق `mcp-app` — نقطة MCP هي `<origin>/mcp` واللوحة على `<origin>/`.

> 💡 عند كل Deploy جديد قد يتغير النطاق؛ ضع `MERGER_PUBLIC_BASE` بنطاق الدمج الثابت أو حدّث `MERGER_API_BASE` في المشروع الآخر.

### ملاحظات الخطة المجانية التي يجب معرفتها

- **مدة الدالة:** الافتراضي 60 ثانية؛ `maxDuration=300` مضبوط في الكود (يعمل مع Fluid Compute على Hobby/Pro). إن رفض النشر القيمة على خطتك، خفّضها إلى 60 في `mcp-app/src/app/mcp/route.ts`.
- **حجم الطلب ≈ 4.5MB:** لذلك رفع الملفات من واجهة الدمج يكون **أجزاء POST ثنائية 4MB** مع إعادة محاولة ×3.
- **حجم قاعدة Turso المجانية:** ~5GB — Blobs الفيديو تُخزَّن صفوفًا 2MB وتُحذف تلقائيًا بعد 24 ساعة (تنظيف كسول + Cron يومي على `/api/cron`).
- **حجم دالة Vercel:** ثنائي ffmpeg+ffprobe يُحزم مع الدالة (~110MB) — ضمن حد 250MB.

## 4) الربط بعملاء MCP

بعد نشر `mcp-app`:

```json
{
  "mcpServers": {
    "media-generator": {
      "url": "https://<نطاق-mcp-app>.vercel.app/mcp"
    }
  }
}
```

- **ChatGPT:** Settings → Connectors → Create → Custom MCP server → ضع الرابط في «Server URL».
- **Claude Desktop:** نفس الكتلة مع `"type": "http"` داخل `claude_desktop_config.json`.
- **Cursor / Windsurf / Cline:** نفس الكتلة في `mcp.json`.

أضف مفاتيحك أولًا من لوحة الإدارة (`/`): كل مفتاح يُجرَّب **بالترتيب الذي أضفته** مع تبديل فوري صامت عند خطأ/نفاد رصيد، والعميل لا يرى أخطاء المفاتيح أبدًا.

## 5) اختبار سريع بعد النشر

```bash
# الجهوزية (مشروع mcp-app)
curl https://<mcp-app>/api/health

# تهيئة جلسة MCP
curl -X POST https://<mcp-app>/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# جهوزية خدمة الدمج
curl https://<merger>/api/config

# دمج مقطعين بـ curl (مشروع merger)
curl -X POST https://<merger>/api/jobs -H 'Content-Type: application/json' \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
# ثم: curl -X POST https://<merger>/api/jobs/<id>/process
```

## 6) التشغيل والاختبار محليًا

```bash
# مشروع mcp-app
cd mcp-app && cp ../.env.example .env.local  # ثم عبّئ القيم
npm install && npm run dev                   # http://localhost:3000

# مشروع merger
cd merger && cp ../.env.example .env         # ثم عبّئ القيم
npm install && npm run dev                   # http://localhost:8787
npm run test:unit                            # 21 اختبار وحدات
npm run test:http                            # 26 اختبار HTTP كامل (يتطلب dev server)
```

الاختبارات الحقيقية المنفذة أثناء البناء موثقة في [TESTING.md](./TESTING.md).

## 7) قواعد ذهبية مطبقة في الكود

1. روابط فقط — لا تنزيل وسائط للسيرفر أبدًا.
2. ترتيب المفاتيح تسلسلي صارم (`created_at ASC, id ASC`) — ليس round-robin.
3. المفتاح المستنزف يبقى في القاعدة والقائمة؛ المعطّل يدويًا فقط هو المستبعد.
4. نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد — التبديل صامت تمامًا.
5. مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد مع كل `get_task` (تهدئة 45 ثانية).
6. أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل حتمي؛ أخطاء شبكتنا = مؤقتة.
7. ملفات الدمج تُحذف بعد 24 ساعة — مذكورة في وصف الأداة وSERVER_INSTRUCTIONS.
8. إخفاء المفاتيح إلزامي (`maskKey`) في كل الاستجابات والسجلات.
9. لا أسرار في Git — `.env*` مستثناة منذ أول commit.

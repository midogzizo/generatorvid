# MCP Media Generator — خادم MCP لتوليد الوسائط

خادم MCP (نقل Streamable HTTP) + لوحة إدارة عربية RTL على تطبيق Next.js واحد:

- **5 أدوات MCP:** `generate_image` · `generate_video` · `merge_videos` · `get_task` · `list_media`
- **الموديلات المدمجة:** صور `gpt-image-2-6/flare-text-to-image` وفيديو `grok-imagine-video-1-5-preview` (صوت متزامن أصلي) عبر kie.ai وCometAPI
- **تبديل مفاتيح تسلسلي صارم:** أول مفتاح أُضيف يُجرَّب أولًا (`created_at ASC, id ASC`)، تبديل فوري صامت عند أي خطأ/نفاد رصيد، واستئناف **نفس المهمة بنفس task_id** — ونموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أبدًا
- **دمج مقاطع** عبر خدمة Video Merger API (انظر `../merger`)
- **روابط فقط:** لا يُنزَّل أي ملف وسائط على السيرفر — تُخزَّن الروابط في Turso

النشر والتوثيق الكامل في [README المستودع الجذري](../README.md). توثيق API لواجهة الدمج في [`../merger/README.md`](../merger/README.md).

## بنية الكود

```
src/
├── app/
│   ├── mcp/route.ts                 # خادم MCP — SDK الرسمي WebStandardStreamableHTTPServerTransport (stateless)
│   ├── api/keys/                    # إدارة المفاتيح (مقنّعة دائمًا)
│   ├── api/keys/[id]/               # تعطيل/تنشيط/حذف
│   ├── api/health/                  # الجهوزية: Turso + الموديلات + خدمة الدمج + حالة التوثيق
│   ├── api/tasks/                   # تغذية لوحة المهام
│   ├── layout.tsx / page.tsx        # RTL عربية بخط Cairo
│   └── globals.css
├── components/Dashboard.tsx         # اللوحة الثلاثية: المفاتيح / المهام / ربط السيرفر
└── lib/
    ├── turso.ts                     # العميل + المخطط + عمليات المهام والمفاتيح
    ├── keys.ts                      # getKeyPool التسلسلي + classifyProviderError + maskKey + تعقيم الأخطاء
    ├── models.ts                    # سجل MODELS مع التوحيد (شرطات/نقاط) وتجاوز متغيرات البيئة
    ├── generation.ts                # runGeneration + refreshTask — قلب التبديل التسلسلي
    ├── merger.ts                    # عميل خدمة الدمج v2 (تحليل دفاعي + قفل process)
    ├── urlcheck.ts                  # فحص الروابط العامة المباشرة
    ├── providers/                   # kie.ts (Jobs API المقاس فعليًا) + cometapi.ts + types.ts
    └── mcp/                         # server.ts (الأدوات الخمس) + format.ts (الصياغة العربية)
```

## متغيرات البيئة

انظر `.env.example` في الجذر. الإلزامي: `TURSO_DATABASE_URL`، `TURSO_AUTH_TOKEN`، `MERGER_API_BASE` (نطاق مشروع الدمج). اختياري: `MCP_ACCESS_TOKEN` و `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL`.

## التشغيل والاختبار

```bash
npm install
cp ../.env.example .env.local && # عبّئ القيم
npm run dev                      # http://localhost:3000 (اللوحة) و /mcp (الخادم)
npm run typecheck && npm run build
```

## ملاحظات تنفيذية

- وضع `stateless` على `/mcp` (بلا خريطة جلسات) — الخيار الصحيح للـ serverless: كل نداء مكتفٍ ذاتيًا حسب مواصفة Streamable HTTP، وإشعارات التقدم تُبث عبر بث SSE الخاص بالطلب عندما يمرر العميل `_meta.progressToken`.
- خادم التطوير قد يفقد ذاكرة الوحدات عند إعادة الترجمة (سلوك dev فقط) — في الإنتاج المثيل مستقر.
- ردود الأدوات بالعربية حسب المواصفة؛ مخططات الأدوات وأوصافها بالإنجليزية لأنها تُقرأ من النموذج.
- رسالة «أداة غير معروفة» تخرج من SDK بالإنجليزية (`Unknown tool`) لأن التسجيل عبر `registerTool` الرسمي — حد تقني مقصود.

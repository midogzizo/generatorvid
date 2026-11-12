"use client";

// لوحة التحكم العربية RTL — ثلاث بطاقات: المفاتيح، المهام، ربط السيرفر
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type KeyStatus = "active" | "exhausted" | "disabled";
interface KeyItem {
  id: string; provider: string; label: string; masked: string; status: KeyStatus;
  usage_count: number; success_count: number; fail_count: number;
  last_error: string | null; created_at: string;
}
interface TaskItem {
  id: string; type: string; model: string; provider: string | null; status: string;
  progress: number; prompt: string; urls: string[]; error: string | null; attempts: number; created_at: string;
}
interface Health {
  ok: boolean; database: string; mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

const TOOL_CHIPS = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي — تعيد الرابط أو task_id" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن — task_id يُتابع بـ get_task" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى اكتمالها" },
  { name: "list_media", desc: "استرجاع الوسائط المخزنة سابقًا بروابطها" },
];

function statusBadge(s: KeyStatus) {
  const map: Record<KeyStatus, string> = {
    active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    exhausted: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    disabled: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  };
  const label: Record<KeyStatus, string> = { active: "نشط", exhausted: "مستنزف", disabled: "معطّل" };
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${map[s]}`}>{label[s]}</span>;
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
    refreshKeys();
    refreshTasks();
    const t = setInterval(refreshTasks, 5000); // تحديث تلقائي للمهام كل ~5 ثوانٍ
    const h = setInterval(() => fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {}), 15000);
    return () => { clearInterval(t); clearInterval(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      setKeys(j.keys || []);
    } catch {}
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20");
      const j = await r.json();
      setTasks(j.tasks || []);
      if (j.stats) setStats(j.stats);
    } catch {}
  }, []);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 space-y-8">
      <Header health={health} origin={origin} />
      <KeysPanel keys={keys} onChanged={refreshKeys} />
      <TasksPanel tasks={tasks} stats={stats} />
      <ConnectPanel origin={origin} authRequired={health?.authRequired || false} />
      <footer className="pt-4 text-center text-xs text-slate-500">
        MCP Media Generator v1.2.0 — لا تُنزَّل أي وسائط على السيرفر؛ تُخزَّن الروابط فقط في قاعدة Turso.
      </footer>
    </main>
  );
}

function Header({ health, origin }: { health: Health | null; origin: string }) {
  const connected = health?.database === "turso-connected";
  return (
    <header className="rounded-2xl border border-slate-800 bg-gradient-to-l from-cyan-950/40 via-slate-900 to-violet-950/40 p-6 shadow-xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">🎬 مولّد الوسائط MCP</h1>
          <p className="mt-1 text-sm text-slate-400">
            توليد صور وفيديو بالذكاء الاصطناعي + دمج المقاطع — عبر بروتوكول MCP للمطورين والوكلاء
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full border px-3 py-1 font-bold ${connected ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>
            {connected ? "● Turso متصل" : "● غير متصل"}
          </span>
          <span className={`rounded-full border px-3 py-1 font-bold ${health?.merger?.healthy ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300"}`}>
            خدمة الدمج: {health?.merger?.healthy ? "جهوزية" : "غير متاحة"}
          </span>
          {health?.authRequired && (
            <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-3 py-1 font-bold text-cyan-300">محتوى بـ Bearer Token</span>
          )}
        </div>
      </div>
      {origin && (
        <p className="mt-3 text-xs text-slate-500">
          نقطة MCP: <code className="rounded bg-slate-800 px-1.5 py-0.5 text-cyan-300">{origin}/mcp</code>
        </p>
      )}
    </header>
  );
}

function KeysPanel({ keys, onChanged }: { keys: KeyItem[]; onChanged: () => void }) {
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const addKey = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "فشل الإضافة");
      setMsg({ text: "تمت إضافة المفتاح بنجاح", ok: true });
      setApiKey(""); setLabel("");
      onChanged();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally { setBusy(false); }
  };

  const toggle = async (k: KeyItem) => {
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: k.status === "disabled" ? "active" : "disabled" }),
    });
    onChanged();
  };
  const remove = async (k: KeyItem) => {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    onChanged();
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg">
      <h2 className="mb-1 text-lg font-bold">🔑 مدير المفاتيح</h2>
      <p className="mb-4 text-xs leading-6 text-amber-300/90 bg-amber-500/5 border border-amber-500/20 rounded-xl px-3 py-2">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
      </p>

      <div className="mb-5 grid gap-3 md:grid-cols-4">
        <select value={provider} onChange={(e) => setProvider(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm">
          <option value="kie">kie.ai</option>
          <option value="cometapi">CometAPI</option>
        </select>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="تسمية اختيارية" className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm" />
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="الصق مفتاح API هنا" className="md:col-span-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm mono" />
        <button onClick={addKey} disabled={busy || !apiKey.trim()} className="rounded-lg bg-gradient-to-l from-cyan-600 to-violet-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-40 hover:opacity-90">
          {busy ? "جارٍ الإضافة…" : "إضافة المفتاح"}
        </button>
      </div>
      {msg && <p className={`mb-3 text-xs ${msg.ok ? "text-emerald-300" : "text-red-300"}`}>{msg.text}</p>}

      {keys.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">لا توجد مفاتيح بعد — أضف أول مفتاح للبدء.</p>
      ) : (
        <ul className="space-y-3">
          {keys.map((k, i) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
              <span className="text-xs text-slate-500 w-5">{i + 1}.</span>
              <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs font-bold text-cyan-300">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</span>
              {statusBadge(k.status)}
              <code className="text-sm text-slate-200">{k.masked}</code>
              {k.label && <span className="text-xs text-slate-400">«{k.label}»</span>}
              <span className="text-[11px] text-slate-500">
                استخدام: <b className="text-slate-300">{k.usage_count}</b> · نجاح: <b className="text-emerald-300">{k.success_count}</b> · فشل: <b className="text-red-300">{k.fail_count}</b>
              </span>
              {k.last_error && <span className="w-full text-[11px] text-red-300/80 truncate">آخر خطأ: {k.last_error}</span>}
              <span className="flex-1" />
              <button onClick={() => toggle(k)} className="rounded-lg border border-slate-600 px-3 py-1 text-xs hover:bg-slate-800">
                {k.status === "disabled" ? "تنشيط" : "تعطيل"}
              </button>
              <button onClick={() => remove(k)} className="rounded-lg border border-red-700/60 px-3 py-1 text-xs text-red-300 hover:bg-red-900/30">حذف</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TasksPanel({ tasks, stats }: { tasks: TaskItem[]; stats: { total: number; completed: number; failed: number; processing: number } }) {
  const chips = [
    { label: "الإجمالي", v: stats.total, c: "text-slate-200 border-slate-600 bg-slate-800/60" },
    { label: "مكتملة", v: stats.completed, c: "text-emerald-300 border-emerald-600/40 bg-emerald-500/10" },
    { label: "فاشلة", v: stats.failed, c: "text-red-300 border-red-600/40 bg-red-500/10" },
    { label: "جارية", v: stats.processing, c: "text-cyan-300 border-cyan-600/40 bg-cyan-500/10" },
  ];
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg">
      <h2 className="mb-4 text-lg font-bold">📊 لوحة المهام <span className="text-xs font-normal text-slate-500">(تحديث تلقائي كل 5 ثوانٍ)</span></h2>
      <div className="mb-5 grid grid-cols-4 gap-3">
        {chips.map((c) => (
          <div key={c.label} className={`rounded-xl border px-4 py-3 text-center ${c.c}`}>
            <div className="text-2xl font-extrabold">{c.v}</div>
            <div className="text-xs opacity-80">{c.label}</div>
          </div>
        ))}
      </div>
      {tasks.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">لا توجد مهام بعد — أول استدعاء لأداة توليد سيظهر هنا.</p>
      ) : (
        <ul className="space-y-3">
          {tasks.map((t) => (
            <li key={t.id} className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs font-bold text-violet-300">
                  {t.type === "image" ? "🖼️ صورة" : t.type === "video" ? "🎥 فيديو" : "🔗 دمج"}
                </span>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                  t.status === "completed" ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                  : t.status === "failed" ? "border-red-500/40 text-red-300 bg-red-500/10"
                  : "border-cyan-500/40 text-cyan-300 bg-cyan-500/10"}`}>
                  {t.status === "completed" ? "مكتملة" : t.status === "failed" ? "فاشلة" : "جارية"}
                </span>
                <code className="text-xs text-slate-400">{t.model}</code>
                <span className="text-xs text-slate-500">محاولات: {t.attempts}</span>
                <span className="flex-1" />
                <span className="text-[11px] text-slate-500">{t.created_at?.replace("T", " ").slice(0, 19)}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-slate-400">{t.prompt}</p>
              {t.status !== "failed" && (
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div className="progress-bar h-full rounded-full transition-all" style={{ width: `${t.progress}%` }} />
                </div>
              )}
              {t.error && <p className="mt-2 text-xs text-red-300">❌ {t.error}</p>}
              {t.status === "completed" && t.urls.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.urls.map((u, i) => (
                    <a key={i} href={u} target="_blank" rel="noreferrer" className="rounded-lg border border-cyan-600/50 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300 hover:bg-cyan-500/20">
                      فتح النتيجة {t.urls.length > 1 ? i + 1 : ""} ↗
                    </a>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectPanel({ origin, authRequired }: { origin: string; authRequired: boolean }) {
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [copied, setCopied] = useState<string | null>(null);
  const mcpUrl = origin ? `${origin}/mcp` : "https://<your-domain>/mcp";
  const headers = authRequired ? `, "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }` : "";

  const jsons = useMemo(() => ({
    chatgpt: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${headers}\n    }\n  }\n}`,
    claude: `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${headers}\n    }\n  }\n}`,
    cursor: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${headers}\n    }\n  }\n}`,
  }), [mcpUrl, headers]);

  const tabNames = { chatgpt: "ChatGPT / GPT Agents", claude: "Claude Desktop", cursor: "Cursor / Windsurf / Cline" } as const;
  const tabHints = {
    chatgpt: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضَع الرابط في «Server URL».",
    claude: "أضف الكتلة إلى ملف claude_desktop_config.json ثم أعد تشغيل التطبيق.",
    cursor: "أضف الكتلة إلى mcp.json داخل إعدادات MCP في المحرر.",
  } as const;

  const copy = async (text: string, tag: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(tag);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-lg">
      <h2 className="mb-4 text-lg font-bold">🔌 ربط السيرفر</h2>
      <div className="mb-5 flex items-center gap-2">
        <code className="flex-1 truncate rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-cyan-300">{mcpUrl}</code>
        <button onClick={() => copy(mcpUrl, "url")} className="rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-xs hover:bg-slate-700">
          {copied === "url" ? "✓ نُسخ" : "نسخ"}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {(Object.keys(tabNames) as (keyof typeof tabNames)[]).map((k) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-full px-4 py-1.5 text-xs font-bold ${tab === k ? "bg-gradient-to-l from-cyan-600 to-violet-600 text-white" : "border border-slate-700 text-slate-300 hover:bg-slate-800"}`}>
            {tabNames[k]}
          </button>
        ))}
      </div>
      <p className="mb-2 text-xs text-slate-400">{tabHints[tab]}</p>
      <div className="relative">
        <pre className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs leading-6 text-emerald-200 mono">{jsons[tab]}</pre>
        <button onClick={() => copy(jsons[tab], "json")} className="absolute top-2 left-2 rounded-md bg-slate-800 border border-slate-600 px-2 py-1 text-[11px] hover:bg-slate-700">
          {copied === "json" ? "✓ نُسخ" : "نسخ JSON"}
        </button>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {TOOL_CHIPS.map((t) => (
          <div key={t.name} className="rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2">
            <code className="text-xs font-bold text-violet-300">{t.name}</code>
            <p className="mt-0.5 text-[11px] text-slate-400">{t.desc}</p>
          </div>
        ))}
      </div>

      <p className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-6 text-amber-200/90">
        ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف.
        أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
      </p>
    </section>
  );
}

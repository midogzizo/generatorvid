// أداة اختبار محلية: إدخال مهمتين مكتملتين بروابط عامة لاختبار حلّ task_ids بالترتيب
import { createClient } from "@libsql/client";
const c = createClient({ url: "file:/home/z/my-project/generatorvid/mcp-app/local-dev.db" });
const urls = [
  "https://www.w3schools.com/html/mov_bbb.mp4",
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
];
const ids = [];
for (let i = 0; i < 2; i++) {
  const id = crypto.randomUUID();
  ids.push(id);
  await c.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, attempts_json)
          VALUES (?, 'kie', 'fake-${i}', NULL, 'grok-imagine-video-1-5-preview', 'video', 'مهمة اختبار ${i}', '{}', 'completed', 100, ?, '[]')`,
    args: [id, JSON.stringify([urls[i]])],
  });
}
console.log(JSON.stringify({ ids }));

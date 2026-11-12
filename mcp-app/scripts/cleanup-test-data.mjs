// تنظيف آثار الاختبار من قاعدة mcp-app المحلية: حذف كل مهام الاختبار والمفتاح الخاطئ
import { createClient } from "@libsql/client";
const c = createClient({ url: "file:/home/z/my-project/generatorvid/mcp-app/local-dev.db" });
const del = await c.execute(`DELETE FROM tasks`);
const wrongKey = await c.execute({ sql: `DELETE FROM api_keys WHERE label LIKE '%خاطئ%'`, args: [] });
const left = await c.execute(`SELECT id, status, type FROM tasks`);
const keys = await c.execute(`SELECT label, status FROM api_keys`);
console.log("deleted tasks:", del.rowsAffected, "| deleted wrong keys:", wrongKey.rowsAffected);
console.log("remaining tasks:", left.rows.length, "| remaining keys:", keys.rows.length);

import { access } from "node:fs/promises";
import { createApp } from "../server.js";
for (const path of [
  "public/index.html",
  "public/app.js",
  "public/style.css",
  "public/font.woff2",
  "public/food-categories.png",
  "public/kkoma-gimbap.png",
  "public/yukgaejang-kalguksu.png",
  "public/yukhoe-bibimbap.png",
  "api/index.js",
])
  await access(path);
console.log("Lunchpass static assets and serverless entry are ready.");
// Verify the actual hosting environment's database without creating test accounts.
// Vercel supplies production secrets to this process; never print their values.
if (process.env.DATABASE_URL) {
  const { server, db } = createApp();
  try {
    if (!db.postgres) throw new Error("INVALID_DATABASE_URL");
    await db.ready;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/status`,
      { signal: AbortSignal.timeout(15000) },
    );
    const data = await response.json();
    if (response.status !== 200 || data.clock?.timezone !== "Asia/Seoul")
      throw new Error("STATUS_CHECK_FAILED");
    if (data.setupNeeded && !data.setupAvailable)
      throw new Error("INITIAL_SETUP_KEY_MISSING");
    const { n } = await db.prepare("SELECT COUNT(*) n FROM restaurants").get();
    const { n: linked } = await db
      .prepare("SELECT COUNT(*) n FROM restaurants WHERE naver_url<>''")
      .get();
    console.log(
      `Hosting database connection, schema and status API verified (${n} restaurants, ${linked} Naver links).`,
    );
  } catch (error) {
    console.error(
      "Hosting readiness check failed:",
      error.code || error.message,
    );
    process.exitCode = 1;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await db.close();
  }
}

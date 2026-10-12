import { createApp } from "../server.js";
export function createVercelHandler({
  appFactory = createApp,
  configured = () => Boolean(process.env.DATABASE_URL),
} = {}) {
  let app;
  return async function handler(req, res) {
    if (!configured()) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "Vercel에 PostgreSQL DATABASE_URL 환경 변수를 연결해주세요.",
        }),
      );
      return;
    }
    if (!app) app = appFactory();
    const url = new URL(req.url, "https://localhost");
    const route = url.searchParams.get("route");
    if (route !== null) {
      url.searchParams.delete("route");
      req.url = "/" + route + (url.search ? url.search : "");
    }
    await app.handler(req, res);
  };
}
export default createVercelHandler();

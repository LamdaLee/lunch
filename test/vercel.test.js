import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fixture, testPassword } from "./helpers.js";
import { createVercelHandler } from "../api/index.js";
import { createApp } from "../server.js";
import { openStore } from "../lib/store.js";

test("Vercel rewrite 경로·미리 파싱된 요청 본문으로 로그인과 예약 작동", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const handler = createVercelHandler({
    appFactory: () => app,
    configured: () => true,
  });
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      req.body = JSON.parse(raw);
    }
    await handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/index?route=api/`;
  const login = await fetch(base + "login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: "ax001", password: testPassword }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const reservation = await fetch(base + "reservation", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ restaurantId: 1 }),
  });
  assert.equal(reservation.status, 200);
  const dashboard = await fetch(base + "dashboard", {
    headers: { Cookie: cookie },
  });
  assert.equal((await dashboard.json()).reservation.name, "한끼식당");
});
test(
  "PostgreSQL 여러 서버 인스턴스에서 같은 마지막 자리 예약 시 한 명만 성공",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const app = await fixture();
    t.after(() => app.close());
    const secondDb = openStore(app.databasePath);
    await secondDb.ready;
    const second = createApp({
      db: secondDb,
      now: () => new Date("2026-10-12T10:00:00+09:00"),
    });
    await new Promise((resolve) =>
      second.server.listen(0, "127.0.0.1", resolve),
    );
    t.after(async () => {
      await new Promise((resolve) => second.server.close(resolve));
      await secondDb.close();
    });
    const cookie1 = await app.login("AX학생"),
      cookie2 = await app.login("SF학생");
    const base2 = `http://127.0.0.1:${second.server.address().port}`;
    const result = await Promise.all([
      fetch(app.base + "/api/reservation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie1 },
        body: JSON.stringify({ restaurantId: 2 }),
      }),
      fetch(base2 + "/api/reservation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie2 },
        body: JSON.stringify({ restaurantId: 2 }),
      }),
    ]);
    assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (
        await app.db
          .prepare("SELECT COUNT(*) n FROM reservations WHERE restaurant_id=2")
          .get()
      ).n,
      1,
    );
  },
);

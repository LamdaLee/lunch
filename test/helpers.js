import { openStore, createAdmin, passwordHash } from "../lib/store.js";
import { createApp } from "../server.js";
import pg from "pg";
import { randomBytes } from "node:crypto";

export const testPassword = "test-only-password-284";
export async function fixture({
  path = ":memory:",
  time = "2026-10-12T10:00:00+09:00",
  seed = true,
} = {}) {
  let cleanupPool, schema;
  if (path === ":memory:" && process.env.TEST_DATABASE_URL) {
    cleanupPool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    schema = "lunchpass_test_" + randomBytes(8).toString("hex");
    await cleanupPool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    path = url.toString();
  }
  const db = openStore(path);
  await db.ready;
  let current = new Date(time);
  if (seed) {
    await createAdmin(db, "테스트관리자", testPassword);
    const add = db.prepare(
      "INSERT INTO users(name,login_id,track,role,password,must_change) VALUES (?,?,?,'member',?,0)",
    );
    await add.run("AX학생", "ax001", "AX", passwordHash(testPassword));
    await add.run("SF학생", "sf001", "SF", passwordHash(testPassword));
    await add.run(
      "테스트강사",
      "staff001",
      "OTHER",
      passwordHash(testPassword),
    );
    await db.prepare("UPDATE users SET must_change=0").run();
    await db
      .prepare(
        "UPDATE restaurants SET name='한끼식당',description='따뜻한 집밥과 함께하는 점심',menu='제육덮밥 · 김치찌개',capacity=2,active=1 WHERE id=1",
      )
      .run();
    await db
      .prepare(
        "UPDATE restaurants SET name='온기국수',description='정성스럽게 준비하는 국수 한 그릇',menu='잔치국수 · 비빔국수',capacity=1,active=1 WHERE id=2",
      )
      .run();
    await db
      .prepare(
        "UPDATE restaurants SET name='초록테이블',description='가볍고 든든한 샐러드와 덮밥',menu='닭가슴살 샐러드 · 연어덮밥',capacity=10,active=1 WHERE id=3",
      )
      .run();
    await db
      .prepare(
        "UPDATE restaurants SET name='모락모락',description='갓 지은 밥과 오늘의 반찬',menu='오늘의 백반',capacity=8,active=1 WHERE id=4",
      )
      .run();
  }
  const { server, handler } = createApp({ db, now: () => current });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(
    path,
    { method = "GET", body, cookie, headers = {} } = {},
  ) {
    const response = await fetch(base + "/api" + path, {
      method,
      headers: {
        ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  async function login(name) {
    const response = await request("/login", {
      method: "POST",
      body: {
        loginId:
          {
            테스트관리자: "admin",
            AX학생: "ax001",
            SF학생: "sf001",
            테스트강사: "staff001",
          }[name] || name,
        password: testPassword,
      },
    });
    if (response.status !== 200) throw new Error(JSON.stringify(response));
    return response.cookie;
  }
  return {
    db,
    server,
    handler,
    databasePath: path,
    base,
    request,
    login,
    setTime: (value) => {
      current = new Date(value);
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
      if (cleanupPool) {
        await cleanupPool.query(`DROP SCHEMA ${schema} CASCADE`);
        await cleanupPool.end();
      }
    },
  };
}

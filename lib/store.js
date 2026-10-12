import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

export const token = () => randomBytes(24).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function openStore(
  path = process.env.DATABASE_URL ||
    process.env.DB_PATH ||
    ".local/lunchpass.sqlite",
) {
  const postgres = /^postgres(?:ql)?:/.test(path);
  const context = new AsyncLocalStorage();
  let sqlite, pool;
  if (postgres) {
    // Provider URL controls TLS. Keep certificate verification enabled.
    const connectionString = path.replace(
      /([?&])sslmode=require(?=&|$)/,
      "$1sslmode=verify-full",
    );
    pool = new pg.Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });
    pool.on("error", (error) =>
      console.error("Database connection error:", error.code || error.name),
    );
  } else {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    sqlite = new DatabaseSync(path);
    sqlite.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
  }
  let tail = Promise.resolve();
  const locked = async (fn) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  const normalize = (rows) =>
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "string" && ["count", "n"].includes(key)
            ? Number(value)
            : value,
        ]),
      ),
    );
  const execute = async (sql, values, mode) => {
    const current = context.getStore();
    const run = async () => {
      if (postgres) {
        let index = 0;
        const query = sql.replace(/\?/g, () => `$${++index}`);
        const result = await (current?.client || pool).query(query, values);
        const rows = normalize(result.rows || []);
        return mode === "all"
          ? rows
          : mode === "get"
            ? rows[0]
            : { changes: result.rowCount };
      }
      const statement = sqlite.prepare(sql);
      return statement[mode](...values);
    };
    return !postgres && !current ? locked(run) : run();
  };
  const db = {
    postgres,
    prepare: (sql) => ({
      get: (...values) => execute(sql, values, "get"),
      all: (...values) => execute(sql, values, "all"),
      run: (...values) => execute(sql, values, "run"),
    }),
    exec: async (sql) => {
      const current = context.getStore();
      if (postgres) return (current?.client || pool).query(sql);
      if (current) return sqlite.exec(sql);
      return locked(() => sqlite.exec(sql));
    },
    transaction: async (fn, { readOnly = false } = {}) => {
      if (context.getStore()) return fn();
      if (!postgres)
        return locked(async () => {
          sqlite.exec("BEGIN IMMEDIATE");
          try {
            const result = await context.run({ sqlite: true }, fn);
            sqlite.exec("COMMIT");
            return result;
          } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
          }
        });
      const client = await pool.connect();
      try {
        await client.query(
          readOnly
            ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
            : "BEGIN",
        );
        // Cross-instance transaction lock prevents overbooking in serverless runtimes.
        if (!readOnly)
          await client.query("SELECT pg_advisory_xact_lock(718204912)");
        const result = await context.run({ client }, fn);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: async () => {
      if (postgres) await pool.end();
      else await locked(() => sqlite.close());
    },
  };
  db.ready = db.transaction(async () => {
    let schema = `
    CREATE TABLE IF NOT EXISTS tracks (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, login_id TEXT NOT NULL UNIQUE,
      track TEXT NOT NULL REFERENCES tracks(name),
      role TEXT NOT NULL CHECK(role IN ('member','admin')),
      password TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      must_change INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS restaurants (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      menu TEXT NOT NULL DEFAULT '', capacity INTEGER NOT NULL DEFAULT 0 CHECK(capacity BETWEEN 0 AND 500),
      active INTEGER NOT NULL DEFAULT 0, access_token TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id), day TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(user_id,day)
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    `;
    if (postgres)
      schema = schema
        .replace(/INTEGER PRIMARY KEY/g, "SERIAL PRIMARY KEY")
        .replace(/expires INTEGER/g, "expires BIGINT");
    await db.exec(schema);
    const columns = postgres
      ? await db
          .prepare(
            "SELECT column_name name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='restaurants'",
          )
          .all()
      : await db.prepare("PRAGMA table_info(restaurants)").all();
    if (!columns.some((column) => column.name === "listed"))
      await db.exec(
        "ALTER TABLE restaurants ADD COLUMN listed INTEGER NOT NULL DEFAULT 1",
      );
    const addCategories = !columns.some((column) => column.name === "category");
    if (addCategories)
      await db.exec(
        "ALTER TABLE restaurants ADD COLUMN category TEXT NOT NULL DEFAULT ''",
      );
    const addNaverLinks = !columns.some(
      (column) => column.name === "naver_url",
    );
    if (addNaverLinks)
      await db.exec(
        "ALTER TABLE restaurants ADD COLUMN naver_url TEXT NOT NULL DEFAULT ''",
      );

    const postColumns = postgres
      ? await db
          .prepare(
            "SELECT column_name name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='posts'",
          )
          .all()
      : await db.prepare("PRAGMA table_info(posts)").all();
    if (!postColumns.some((column) => column.name === "title"))
      await db.exec(
        "ALTER TABLE posts ADD COLUMN title TEXT NOT NULL DEFAULT ''",
      );
    const addTrack = db.prepare(
      "INSERT INTO tracks(name) VALUES (?) ON CONFLICT(name) DO NOTHING",
    );
    for (const name of ["AX", "SF", "AX2기", "DM", "OTHER"])
      await addTrack.run(name);
    if (!(await db.prepare("SELECT id FROM restaurants LIMIT 1").get())) {
      const add = db.prepare(
        "INSERT INTO restaurants(name,access_token) VALUES (?,?)",
      );
      for (const name of [
        "복록수",
        "조선명가",
        "3일소고기국밥",
        "7930 손님식탁",
        "칼국수 만드는 사람들",
        "마마김밥",
        "교반",
        "오류동 꼬마김밥",
        "파스토보이",
      ])
        await add.run(name, token());
    }
    if (addCategories) {
      const categories = [
        ["복록수", "중식"],
        ["조선명가", "한식"],
        ["3일소고기국밥", "국밥"],
        ["7930 손님식탁", "돈가스"],
        ["7930 손님식당", "돈가스"],
        ["칼국수 만드는 사람들", "칼국수"],
        ["마마김밥", "분식"],
        ["교반", "비빔밥"],
        ["오류동 꼬마김밥", "꼬마김밥"],
        ["파스토보이", "파스타"],
      ];
      for (const [name, category] of categories)
        await db
          .prepare("UPDATE restaurants SET category=? WHERE name=?")
          .run(category, name);
    }
    if (addNaverLinks) {
      const links = [
        ["복록수", "xIeXiYYf"],
        ["조선명가", "xUwPzf7e"],
        ["3일소고기국밥", "xY4sKAf4"],
        ["7930 손님식탁", "xrSQ14uO"],
        ["7930 손님식당", "xrSQ14uO"],
        ["칼국수 만드는 사람들", "GBFzNjPv"],
        ["마마김밥", "5YFO5Oz5"],
        ["교반", "GEXhLegY"],
        ["오류동 꼬마김밥", "F2Zy00UY"],
        ["파스토보이", "FQVvX8np"],
      ];
      for (const [name, code] of links)
        await db
          .prepare("UPDATE restaurants SET naver_url=? WHERE name=?")
          .run(`https://naver.me/${code}`, name);
    }
  });
  db.ready.catch(() => {}); // Requests report initialization failures without leaking connection URLs.
  return db;
}
export async function createAdmin(db, name, password, loginId = "admin") {
  await db.ready;
  if (await db.prepare("SELECT id FROM users WHERE role='admin'").get())
    throw new Error("관리자 계정이 이미 있습니다.");
  if (
    !name.trim() ||
    name.trim().length > 40 ||
    password.length < 8 ||
    password.length > 128
  )
    throw new Error("이름은 1~40자, 비밀번호는 8~128자여야 합니다.");
  if (!/^[A-Za-z0-9_.@-]{1,40}$/.test(loginId))
    throw new Error("로그인 ID는 영문·숫자 및 _ . @ - 로 입력해주세요.");
  await db
    .prepare(
      "INSERT INTO users(name,login_id,track,role,password) VALUES (?,?,?,?,?)",
    )
    .run(name.trim(), loginId, "OTHER", "admin", passwordHash(password));
}
export function koreaClock(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute,
    phase: minute < 540 ? "before" : minute < 720 ? "open" : "closed",
    label: `${parts.hour}:${parts.minute}`,
    timezone: "Asia/Seoul",
  };
}

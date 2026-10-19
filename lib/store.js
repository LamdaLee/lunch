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
    CREATE TABLE IF NOT EXISTS meal_records (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id), reason TEXT NOT NULL CHECK(reason IN ('sold_out','changed')),
      updated_at TEXT NOT NULL, UNIQUE(user_id,day)
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS post_comments (
      id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id),
      user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS post_comments_post_id_index ON post_comments(post_id,id);
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      name TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0 CHECK(price BETWEEN 0 AND 100000),
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL, body TEXT NOT NULL, target_tab TEXT NOT NULL CHECK(target_tab IN ('admin','missions')),
      event_id INTEGER, created_at TEXT NOT NULL, read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS notifications_user_id_index ON notifications(user_id,id);
    CREATE TABLE IF NOT EXISTS mission_event (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 0, start_day TEXT NOT NULL, end_day TEXT NOT NULL DEFAULT '',
      reward_amount INTEGER NOT NULL DEFAULT 1000 CHECK(reward_amount BETWEEN 1 AND 100000), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_missions (
      id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES mission_event(id),
      kind TEXT NOT NULL CHECK(kind IN ('lunch','recommend','review','entry')),
      title TEXT NOT NULL, description TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 500),
      requires_review INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS mission_claims (
      id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES mission_event(id), mission_id INTEGER NOT NULL REFERENCES event_missions(id),
      user_id INTEGER NOT NULL REFERENCES users(id), mission TEXT NOT NULL,
      entry_name TEXT NOT NULL, entry_login_id TEXT NOT NULL, reward_amount INTEGER NOT NULL,
      condition_snapshot TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','issued')),
      post_id INTEGER, evidence TEXT NOT NULL, created_at TEXT NOT NULL,
      review_note TEXT NOT NULL DEFAULT '', reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT, coupon_code TEXT UNIQUE, UNIQUE(user_id,mission_id)
    );
    `;
    if (postgres)
      schema = schema
        .replace(/INTEGER PRIMARY KEY/g, "SERIAL PRIMARY KEY")
        .replace(/expires INTEGER/g, "expires BIGINT");
    await db.exec(schema);
    if (!(await db.prepare("SELECT id FROM mission_event LIMIT 1").get())) {
      const event = await db
        .prepare(
          "INSERT INTO mission_event(title,description,active,start_day,created_at) VALUES (?,?,0,?,?) RETURNING id",
        )
        .get(
          "점심 체크 챌린지",
          "미션별 선착순 20명에게 1,000원 간식 쿠폰을 드려요.",
          koreaClock(new Date()).day,
          new Date().toISOString(),
        );
      for (const [kind, title, description] of [
        [
          "lunch",
          "오늘 점심 체크하기",
          "12시 전에 갈 식당을 선택하고 실제 식사를 마친 뒤 제출해주세요.",
        ],
        [
          "recommend",
          "맛집 하나 추천하기",
          "게시판에 식당 이름과 추천 메뉴·이유를 남겨주세요.",
        ],
        [
          "review",
          "먹어보고 후기 남기기",
          "방문한 식당의 맛·대기 시간·팁 중 하나를 게시판에 남겨주세요.",
        ],
      ])
        await db
          .prepare(
            "INSERT INTO event_missions(event_id,kind,title,description,capacity,requires_review) VALUES (?,?,?,?,20,1)",
          )
          .run(event.id, kind, title, description);
    }
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
    const reservationColumns = postgres
      ? await db
          .prepare(
            "SELECT column_name name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='reservations'",
          )
          .all()
      : await db.prepare("PRAGMA table_info(reservations)").all();
    if (!reservationColumns.some((column) => column.name === "menu_item_id"))
      await db.exec(
        "ALTER TABLE reservations ADD COLUMN menu_item_id INTEGER REFERENCES menu_items(id)",
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

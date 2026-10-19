import {
  notificationSummary,
  listNotifications,
  readNotification,
} from "./lib/notifications.js";
import {
  missionSummary,
  memberMissions,
  claimMission,
  adminMissions,
  reviewMission,
  saveEvent,
} from "./lib/missions.js";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  openStore,
  koreaClock,
  passwordMatches,
  passwordHash,
  token,
  digest,
} from "./lib/store.js";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const cleanText = (value, max, label) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail(400, `${label}을(를) 1~${max}자로 입력해주세요.`);
  return value.trim();
};
const loginIdOf = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.@-]{1,40}$/.test(value)
    ? value
    : fail(
        400,
        "학번/ID는 영문·숫자 및 _ . @ - 를 사용해 40자 이내로 입력해주세요.",
      );
export function createApp({
  db = openStore(),
  now = () => new Date(),
  secureCookie = process.env.COOKIE_SECURE === "true" ||
    Boolean(process.env.VERCEL),
} = {}) {
  const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
  const handler = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const clock = koreaClock(now());
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const send = (status, data) => ({ status, data });
    const respond = ({ status, data }) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (!path.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(req.method))
          fail(405, "허용되지 않은 요청입니다.");
        const files = {
          "/": ["index.html", "text/html"],
          "/restaurant": ["index.html", "text/html"],
          "/app.js": ["app.js", "text/javascript"],
          "/style.css": ["style.css", "text/css"],
          "/yukgaejang-kalguksu.png": ["yukgaejang-kalguksu.png", "image/png"],
          "/yukhoe-bibimbap.png": ["yukhoe-bibimbap.png", "image/png"],
          "/food-categories.png": ["food-categories.png", "image/png"],
          "/kkoma-gimbap.png": ["kkoma-gimbap.png", "image/png"],
          "/font.woff2": ["font.woff2", "font/woff2"],
          "/FONT-LICENSE.txt": ["FONT-LICENSE.txt", "text/plain"],
        };
        if (!files[path]) fail(404, "페이지를 찾을 수 없습니다.");
        const [file, type] = files[path];
        const content = await readFile(resolve(publicDir, file));
        res.writeHead(200, {
          "Content-Type": `${type}; charset=utf-8`,
          "Cache-Control": "no-cache",
        });
        res.end(req.method === "HEAD" ? undefined : content);
        return;
      }
      let body = {};
      if (req.method !== "GET") {
        if (req.headers["sec-fetch-site"] === "cross-site")
          fail(403, "다른 사이트에서의 요청은 허용되지 않습니다.");
        if (req.headers.origin) {
          let origin;
          try {
            origin = new URL(req.headers.origin);
          } catch {
            fail(403, "요청 출처가 올바르지 않습니다.");
          }
          if (origin.host !== req.headers.host)
            fail(403, "요청 출처가 올바르지 않습니다.");
        }
        if (!req.headers["content-type"]?.startsWith("application/json"))
          fail(415, "JSON 요청이 필요합니다.");
        let raw =
          req.body === undefined
            ? ""
            : typeof req.body === "string"
              ? req.body
              : JSON.stringify(req.body);
        if (req.body === undefined) {
          req.setEncoding("utf8");
          for await (const chunk of req) {
            raw += chunk;
            if (Buffer.byteLength(raw) > 16384)
              fail(413, "입력 내용이 너무 큽니다.");
          }
        }
        if (Buffer.byteLength(raw) > 16384)
          fail(413, "입력 내용이 너무 큽니다.");
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          fail(400, "입력 형식이 올바르지 않습니다.");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          fail(400, "입력 형식이 올바르지 않습니다.");
      }
      await db.ready;
      const result = await db.transaction(
        async () => {
          const sid = req.headers.cookie?.match(
            /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/,
          )?.[1];
          const user = sid
            ? await db
                .prepare(
                  `SELECT u.id,u.name,u.login_id,u.track,u.role,u.must_change FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires>? AND u.active=1`,
                )
                .get(digest(sid), now().getTime())
            : null;
          const requireUser = () => user || fail(401, "로그인이 필요합니다.");
          const trackOf = async (value) =>
            typeof value === "string" &&
            (await db
              .prepare("SELECT name FROM tracks WHERE name=?")
              .get(value))
              ? value
              : fail(400, "등록된 반을 선택해주세요.");
          const requireAdmin = () => {
            requireUser();
            if (user.role !== "admin")
              fail(403, "운영진만 사용할 수 있습니다.");
          };
          const requireOpen = () => {
            const current = koreaClock(now());
            if (current.phase !== "open")
              fail(
                409,
                current.phase === "before"
                  ? "선택과 취소는 오전 9시부터 가능합니다."
                  : "오늘 선택과 취소는 낮 12시 40분에 마감되었습니다.",
              );
          };
          const setSession = async (id) => {
            const value = token();
            await db
              .prepare("DELETE FROM sessions WHERE expires<=?")
              .run(now().getTime());
            await db
              .prepare("INSERT INTO sessions VALUES (?,?,?)")
              .run(digest(value), id, now().getTime() + 12 * 3600000);
            res.setHeader(
              "Set-Cookie",
              `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookie ? "; Secure" : ""}`,
            );
          };
          if (path === "/api/status" && req.method === "GET")
            return send(200, {
              clock,
              user,
              setupNeeded: !(await db
                .prepare("SELECT id FROM users WHERE role='admin'")
                .get()),
              setupAvailable: (process.env.SETUP_KEY?.length || 0) >= 24,
            });
          if (path === "/api/setup" && req.method === "POST") {
            if (
              (process.env.SETUP_KEY?.length || 0) < 24 ||
              typeof body.key !== "string" ||
              !timingSafeEqual(
                Buffer.from(digest(body.key)),
                Buffer.from(digest(process.env.SETUP_KEY)),
              )
            )
              fail(403, "초기 설정 키를 확인해주세요.");
            if (
              await db.prepare("SELECT id FROM users WHERE role='admin'").get()
            )
              fail(409, "관리자 계정이 이미 설정되어 있습니다.");
            const name = cleanText(body.name, 40, "이름"),
              loginId = loginIdOf(body.loginId);
            if (
              typeof body.password !== "string" ||
              body.password.length < 8 ||
              body.password.length > 128
            )
              fail(400, "비밀번호는 8~128자여야 합니다.");
            // Validation and insert share the same transaction, preventing a second bootstrap.
            await db
              .prepare(
                "INSERT INTO users(name,login_id,track,role,password,must_change) VALUES (?,?,?,'admin',?,0)",
              )
              .run(name, loginId, "OTHER", passwordHash(body.password));
            return send(201, { ok: true });
          }
          if (path === "/api/login" && req.method === "POST") {
            const time = now().getTime();
            if (
              typeof body.password !== "string" ||
              body.password.length < 4 ||
              body.password.length > 128 ||
              (body.password.length < 8 && !/^\d{4}$/.test(body.password))
            )
              fail(
                400,
                "초기 비밀번호는 숫자 4자리, 개인 비밀번호는 8~128자입니다.",
              );
            const loginId = loginIdOf(body.loginId);
            const key = digest(loginId);
            const limit = await db
              .prepare("SELECT attempts,expires FROM login_attempts WHERE id=?")
              .get(key);
            if (limit && Number(limit.expires) > time && limit.attempts >= 15)
              fail(429, "시도가 너무 많습니다. 10분 후 다시 시도해주세요.");
            const found = await db
              .prepare("SELECT * FROM users WHERE login_id=? AND active=1")
              .get(loginId);
            if (
              !found ||
              (body.password.length < 8 && !found.must_change) ||
              !passwordMatches(body.password, found.password)
            ) {
              const count =
                limit && Number(limit.expires) > time ? limit.attempts + 1 : 1;
              const expires =
                limit && Number(limit.expires) > time
                  ? Number(limit.expires)
                  : time + 600000;
              await db
                .prepare("DELETE FROM login_attempts WHERE expires<=?")
                .run(time);
              await db
                .prepare(
                  "INSERT INTO login_attempts(id,attempts,expires) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET attempts=excluded.attempts,expires=excluded.expires",
                )
                .run(key, count, expires);
              return send(401, {
                error: "학번/ID 또는 비밀번호를 확인해주세요.",
              });
            }
            await setSession(found.id);
            await db.prepare("DELETE FROM login_attempts WHERE id=?").run(key);
            return send(200, { ok: true });
          }
          if (path === "/api/logout" && req.method === "POST") {
            if (sid)
              await db
                .prepare("DELETE FROM sessions WHERE id=?")
                .run(digest(sid));
            res.setHeader(
              "Set-Cookie",
              `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? "; Secure" : ""}`,
            );
            return send(200, { ok: true });
          }
          const restaurantByToken = async (value) =>
            (typeof value === "string" &&
              (await db
                .prepare(
                  "SELECT id,name,description,menu FROM restaurants WHERE access_token=?",
                )
                .get(value))) ||
            fail(404, "식당 링크가 유효하지 않습니다. 운영진에게 문의해주세요.");
          if (path === "/api/restaurant/menu" && req.method === "POST") {
            const restaurant = await restaurantByToken(body.token);
            const name = cleanText(body.name, 40, "메뉴 이름");
            const price = body.price ?? 0;
            if (!Number.isInteger(price) || price < 0 || price > 100000)
              fail(400, "가격은 0~100,000원 사이의 숫자로 입력해주세요.");
            if (body.id !== undefined) {
              if (!Number.isInteger(body.id)) fail(400, "메뉴를 확인해주세요.");
              const result = await db
                .prepare(
                  "UPDATE menu_items SET name=?,price=? WHERE id=? AND restaurant_id=? AND active=1",
                )
                .run(name, price, body.id, restaurant.id);
              if (!result.changes) fail(404, "메뉴를 찾을 수 없습니다.");
              return send(200, { ok: true });
            }
            const { n } = await db
              .prepare(
                "SELECT COUNT(*) n FROM menu_items WHERE restaurant_id=? AND active=1",
              )
              .get(restaurant.id);
            if (Number(n) >= 30)
              fail(409, "메뉴는 최대 30개까지 등록할 수 있습니다.");
            await db
              .prepare(
                "INSERT INTO menu_items(restaurant_id,name,price) VALUES (?,?,?)",
              )
              .run(restaurant.id, name, price);
            return send(201, { ok: true });
          }
          if (path === "/api/restaurant/menu/remove" && req.method === "POST") {
            const restaurant = await restaurantByToken(body.token);
            if (!Number.isInteger(body.id)) fail(400, "메뉴를 확인해주세요.");
            // Keep the row so existing reservations still show the menu name.
            const result = await db
              .prepare(
                "UPDATE menu_items SET active=0 WHERE id=? AND restaurant_id=? AND active=1",
              )
              .run(body.id, restaurant.id);
            if (!result.changes) fail(404, "메뉴를 찾을 수 없습니다.");
            return send(200, { ok: true });
          }
          if (path === "/api/restaurant" && req.method === "GET") {
            const restaurant = await restaurantByToken(
              url.searchParams.get("token") || "",
            );
            const totals = await db
              .prepare(
                `SELECT u.track, COUNT(*) count FROM reservations r JOIN users u ON u.id=r.user_id WHERE r.restaurant_id=? AND r.day=? GROUP BY u.track`,
              )
              .all(restaurant.id, clock.day);
            const actualTotals = await db
              .prepare(
                `SELECT u.track, COUNT(*) count FROM meal_records m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? AND m.day=? GROUP BY u.track`,
              )
              .all(restaurant.id, clock.day);
            const changedAway = await db
              .prepare(
                `SELECT COUNT(*) count FROM reservations r JOIN meal_records m ON m.user_id=r.user_id AND m.day=r.day WHERE r.restaurant_id=? AND r.day=? AND m.restaurant_id<>r.restaurant_id`,
              )
              .get(restaurant.id, clock.day);
            return send(200, {
              restaurant,
              totals,
              count: totals.reduce((sum, row) => sum + row.count, 0),
              actualTotals,
              actualCount: actualTotals.reduce(
                (sum, row) => sum + row.count,
                0,
              ),
              changedAwayCount: changedAway.count,
              menuItems: await db
                .prepare(
                  "SELECT id,name,price FROM menu_items WHERE restaurant_id=? AND active=1 ORDER BY id",
                )
                .all(restaurant.id),
              // Only people who pre-ordered a menu are listed by name; login IDs stay hidden.
              orders: (
                await db
                  .prepare(
                    "SELECT u.name,u.track,COALESCE(mi.name,r.menu_note) menu,mi.price,r.menu_item_id FROM reservations r JOIN users u ON u.id=r.user_id LEFT JOIN menu_items mi ON mi.id=r.menu_item_id WHERE r.restaurant_id=? AND r.day=? AND (r.menu_item_id IS NOT NULL OR r.menu_note<>'') ORDER BY r.menu_item_id IS NULL,mi.id,u.track,u.name",
                  )
                  .all(restaurant.id, clock.day)
              ).map(({ menu_item_id, ...order }) => ({
                ...order,
                custom: menu_item_id === null,
              })),
              clock,
            });
          }
          requireUser();
          if (path === "/api/password" && req.method === "POST") {
            if (
              typeof body.current !== "string" ||
              body.current.length > 128 ||
              typeof body.password !== "string" ||
              body.password.length < 8 ||
              body.password.length > 128
            )
              fail(400, "새 비밀번호는 8~128자여야 합니다.");
            const existing = await db
              .prepare("SELECT password FROM users WHERE id=?")
              .get(user.id);
            if (!passwordMatches(body.current, existing.password))
              fail(400, "현재 비밀번호를 확인해주세요.");
            if (passwordMatches(body.password, existing.password))
              fail(400, "현재 비밀번호와 다른 새 비밀번호를 입력해주세요.");
            await db
              .prepare("UPDATE users SET password=?,must_change=0 WHERE id=?")
              .run(passwordHash(body.password), user.id);
            await db
              .prepare("DELETE FROM sessions WHERE user_id=? AND id<>?")
              .run(user.id, digest(sid));
            return send(200, { ok: true });
          }
          if (user.must_change)
            fail(403, "첫 로그인 후 비밀번호를 변경해주세요.");
          if (path === "/api/notifications" && req.method === "GET")
            return send(
              200,
              url.searchParams.get("summary") === "1"
                ? await notificationSummary(db, user)
                : await listNotifications(
                    db,
                    user,
                    url.searchParams.get("before"),
                    fail,
                  ),
            );
          if (path === "/api/notifications/read" && req.method === "POST")
            return send(
              200,
              await readNotification(db, user, body, now(), fail),
            );
          if (path === "/api/missions" && req.method === "GET")
            return send(200, await memberMissions(db, user, clock));
          if (path === "/api/missions/claim" && req.method === "POST")
            return send(
              201,
              await claimMission(db, user, clock, body, now(), fail),
            );
          if (path === "/api/meal-record" && req.method === "POST") {
            if (
              typeof body.day !== "string" ||
              !/^\d{4}-\d{2}-\d{2}$/.test(body.day) ||
              body.day > clock.day ||
              !Number.isInteger(body.restaurantId) ||
              !["sold_out", "changed"].includes(body.reason)
            )
              fail(400, "식사 날짜, 식당과 변경 사유를 확인해주세요.");
            if (body.day === clock.day && clock.minute < 840)
              fail(
                409,
                "오늘 실제 식사 기록은 오후 2시부터 수정할 수 있습니다.",
              );
            const planned = await db
              .prepare(
                "SELECT restaurant_id FROM reservations WHERE user_id=? AND day=?",
              )
              .get(user.id, body.day);
            if (!planned)
              fail(404, "본인의 식당 선택 기록이 있어야 수정할 수 있습니다.");
            if (
              !(await db
                .prepare("SELECT id FROM restaurants WHERE id=?")
                .get(body.restaurantId))
            )
              fail(404, "식당을 찾을 수 없습니다.");
            await db
              .prepare(
                "INSERT INTO meal_records(user_id,day,restaurant_id,reason,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET restaurant_id=excluded.restaurant_id,reason=excluded.reason,updated_at=excluded.updated_at",
              )
              .run(
                user.id,
                body.day,
                body.restaurantId,
                body.reason,
                now().toISOString(),
              );
            return send(200, { ok: true });
          }
          if (path === "/api/history" && req.method === "GET") {
            const before = url.searchParams.get("before");
            if (before && !/^\d{4}-\d{2}-\d{2}$/.test(before))
              fail(400, "날짜 형식을 확인해주세요.");
            const rows = await db
              .prepare(
                `SELECT b.day,COALESCE(a.name,r.name) restaurant,r.name planned_restaurant,m.reason FROM reservations b JOIN restaurants r ON r.id=b.restaurant_id LEFT JOIN meal_records m ON m.user_id=b.user_id AND m.day=b.day LEFT JOIN restaurants a ON a.id=m.restaurant_id WHERE b.user_id=? AND b.day<=? ${before ? "AND b.day<?" : ""} ORDER BY b.day DESC LIMIT 51`,
              )
              .all(user.id, clock.day, ...(before ? [before] : []));
            const page = rows.slice(0, 50);
            const records = page.map(({ day, restaurant }) => ({
              day,
              restaurant,
            }));
            return send(200, {
              records,
              corrections: page
                .filter((r) => r.reason)
                .map(({ day, planned_restaurant, reason }) => ({
                  day,
                  plannedRestaurant: planned_restaurant,
                  reason,
                })),
              restaurants: await db
                .prepare("SELECT id,name FROM restaurants ORDER BY id")
                .all(),
              minute: clock.minute,
              day: clock.day,
              nextBefore: rows.length > 50 ? records.at(-1).day : null,
            });
          }
          if (path === "/api/dashboard" && req.method === "GET") {
            const restaurants = await db
              .prepare(
                `SELECT r.id,r.name,r.description,r.menu,r.naver_url,r.category,r.listed, COUNT(b.id) count FROM restaurants r LEFT JOIN reservations b ON b.restaurant_id=r.id AND b.day=? WHERE r.listed=1 GROUP BY r.id ORDER BY r.id`,
              )
              .all(clock.day);
            const reservation =
              (await db
                .prepare(
                  "SELECT b.id,b.restaurant_id,b.menu_item_id,b.menu_note,r.name,COALESCE(mi.name,NULLIF(b.menu_note,'')) menu,mi.price menu_price FROM reservations b JOIN restaurants r ON r.id=b.restaurant_id LEFT JOIN menu_items mi ON mi.id=b.menu_item_id WHERE b.user_id=? AND b.day=?",
                )
                .get(user.id, clock.day)) || null;
            const totals = await db
              .prepare(
                "SELECT b.restaurant_id,u.track,COUNT(*) count FROM reservations b JOIN users u ON u.id=b.user_id WHERE b.day=? GROUP BY b.restaurant_id,u.track",
              )
              .all(clock.day);
            const menuItems = await db
              .prepare(
                "SELECT id,restaurant_id,name,price FROM menu_items WHERE active=1 ORDER BY id",
              )
              .all();
            for (const restaurant of restaurants) {
              restaurant.totals = totals
                .filter((row) => row.restaurant_id === restaurant.id)
                .map(({ track, count }) => ({ track, count }));
              restaurant.menuItems = menuItems
                .filter((item) => item.restaurant_id === restaurant.id)
                .map(({ id, name, price }) => ({ id, name, price }));
            }
            const start = new Date(`${clock.day}T00:00:00+09:00`);
            const end = new Date(start.getTime() + 86400000);
            const todayPosts = (
              await db
                .prepare(
                  "SELECT id,title,body,pinned FROM posts WHERE created_at>=? AND created_at<? ORDER BY pinned DESC,id DESC LIMIT 100",
                )
                .all(start.toISOString(), end.toISOString())
            ).map(({ id, title, body, pinned }) => ({
              id,
              title: title || body.split(/\r?\n/)[0].slice(0, 80),
              pinned,
            }));
            return send(200, {
              missionEvent: (await missionSummary(db)).events.some(
                (e) =>
                  e.active &&
                  clock.day >= e.start_day &&
                  (!e.end_day || clock.day <= e.end_day),
              ),
              todayPosts,
              restaurants,
              reservation,
              choice: reservation,
              clock,
              user,
            });
          }
          if (
            ["/api/choice", "/api/reservation"].includes(path) &&
            req.method === "POST"
          ) {
            requireOpen();
            if (!Number.isInteger(body.restaurantId))
              fail(400, "식당을 선택해주세요.");

            {
              const restaurant = await db
                .prepare("SELECT * FROM restaurants WHERE id=? AND listed=1")
                .get(body.restaurantId);
              if (!restaurant) fail(404, "현재 선택할 수 없는 식당입니다.");
              const menuItemId = body.menuItemId ?? null;
              if (menuItemId !== null && !Number.isInteger(menuItemId))
                fail(400, "메뉴를 확인해주세요.");
              if (
                body.menuNote !== undefined &&
                (typeof body.menuNote !== "string" ||
                  body.menuNote.trim().length > 60)
              )
                fail(400, "직접 적는 메뉴는 60자 이내로 입력해주세요.");
              // A registered menu wins over a typed note; never store both.
              const menuNote =
                menuItemId === null ? (body.menuNote || "").trim() : "";
              if (
                menuItemId === null &&
                !menuNote &&
                (await db
                  .prepare(
                    "SELECT id FROM menu_items WHERE restaurant_id=? AND active=1 LIMIT 1",
                  )
                  .get(restaurant.id))
              )
                fail(400, "예약할 메뉴를 고르거나 직접 적어주세요.");
              if (
                menuItemId !== null &&
                !(await db
                  .prepare(
                    "SELECT id FROM menu_items WHERE id=? AND restaurant_id=? AND active=1",
                  )
                  .get(menuItemId, restaurant.id))
              )
                fail(404, "현재 예약할 수 없는 메뉴입니다.");
              const existing = await db
                .prepare("SELECT * FROM reservations WHERE user_id=? AND day=?")
                .get(user.id, clock.day);
              if (
                existing?.restaurant_id === restaurant.id &&
                (existing.menu_item_id ?? null) === menuItemId &&
                (existing.menu_note || "") === menuNote
              )
                fail(409, "이미 같은 식당·메뉴로 선택했어요.");
              await db
                .prepare(
                  `INSERT INTO reservations(user_id,restaurant_id,day,created_at,menu_item_id,menu_note) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET restaurant_id=excluded.restaurant_id,created_at=excluded.created_at,menu_item_id=excluded.menu_item_id,menu_note=excluded.menu_note`,
                )
                .run(
                  user.id,
                  restaurant.id,
                  clock.day,
                  now().toISOString(),
                  menuItemId,
                  menuNote,
                );
            }
            return send(200, { ok: true });
          }
          if (
            ["/api/choice", "/api/reservation"].includes(path) &&
            req.method === "DELETE"
          ) {
            requireOpen();
            await db
              .prepare("DELETE FROM reservations WHERE user_id=? AND day=?")
              .run(user.id, clock.day);
            return send(200, { ok: true });
          }
          const commentsOf = async (postIds) => {
            if (!postIds.length) return [];
            return db
              .prepare(
                `SELECT c.id,c.post_id,c.user_id,c.body,c.created_at,u.name,u.track FROM post_comments c JOIN users u ON u.id=c.user_id WHERE c.post_id IN (${postIds.map(() => "?").join(",")}) ORDER BY c.id`,
              )
              .all(...postIds);
          };
          if (path === "/api/posts" && req.method === "GET") {
            const posts = await db
              .prepare(
                "SELECT p.id,p.user_id,p.title,p.body,p.pinned,p.created_at,u.name,u.track,u.role FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.pinned DESC,p.id DESC LIMIT 100",
              )
              .all();
            const comments = await commentsOf(posts.map((p) => p.id));
            for (const post of posts)
              post.comments = comments.filter((c) => c.post_id === post.id);
            return send(200, { posts });
          }
          if (path === "/api/posts" && req.method === "POST") {
            const bodyText = cleanText(body.body, 1000, "게시글");
            const title =
              body.title === undefined
                ? bodyText.split(/\r?\n/)[0].slice(0, 80)
                : cleanText(body.title, 80, "제목");
            const recent = await db
              .prepare(
                "SELECT created_at FROM posts WHERE user_id=? ORDER BY id DESC LIMIT 1",
              )
              .get(user.id);
            if (
              recent &&
              now().getTime() - Date.parse(recent.created_at) < 10000
            )
              fail(429, "게시글은 10초 간격으로 작성할 수 있습니다.");
            await db
              .prepare(
                "INSERT INTO posts(user_id,title,body,pinned,created_at) VALUES (?,?,?,?,?)",
              )
              .run(
                user.id,
                title,
                bodyText,
                user.role === "admin" && body.pinned ? 1 : 0,
                now().toISOString(),
              );
            return send(201, { ok: true });
          }
          const postMatch = path.match(/^\/api\/posts\/(\d+)$/);
          if (postMatch && req.method === "GET") {
            const post = await db
              .prepare(
                "SELECT p.id,p.title,p.body,p.created_at,u.name FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?",
              )
              .get(Number(postMatch[1]));
            if (!post) fail(404, "게시글을 찾을 수 없습니다.");
            post.comments = await commentsOf([post.id]);
            return send(200, { post });
          }
          const commentsMatch = path.match(/^\/api\/posts\/(\d+)\/comments$/);
          if (commentsMatch && req.method === "POST") {
            const postId = Number(commentsMatch[1]);
            const commentText = cleanText(body.body, 500, "댓글");
            if (
              !(await db.prepare("SELECT id FROM posts WHERE id=?").get(postId))
            )
              fail(404, "게시글을 찾을 수 없습니다.");
            const recent = await db
              .prepare(
                "SELECT created_at FROM post_comments WHERE user_id=? ORDER BY id DESC LIMIT 1",
              )
              .get(user.id);
            if (
              recent &&
              now().getTime() - Date.parse(recent.created_at) < 5000
            )
              fail(429, "댓글은 5초 간격으로 작성할 수 있습니다.");
            await db
              .prepare(
                "INSERT INTO post_comments(post_id,user_id,body,created_at) VALUES (?,?,?,?)",
              )
              .run(postId, user.id, commentText, now().toISOString());
            return send(201, { ok: true });
          }
          const commentMatch = path.match(/^\/api\/comments\/(\d+)$/);
          if (commentMatch && req.method === "DELETE") {
            const comment = await db
              .prepare("SELECT user_id FROM post_comments WHERE id=?")
              .get(Number(commentMatch[1]));
            if (!comment) fail(404, "댓글을 찾을 수 없습니다.");
            if (comment.user_id !== user.id && user.role !== "admin")
              fail(403, "작성자 또는 운영진만 삭제할 수 있습니다.");
            await db
              .prepare("DELETE FROM post_comments WHERE id=?")
              .run(Number(commentMatch[1]));
            return send(200, { ok: true });
          }
          if (postMatch && req.method === "DELETE") {
            const post = await db
              .prepare("SELECT user_id FROM posts WHERE id=?")
              .get(Number(postMatch[1]));
            if (!post) fail(404, "게시글을 찾을 수 없습니다.");
            if (post.user_id !== user.id && user.role !== "admin")
              fail(403, "작성자 또는 운영진만 삭제할 수 있습니다.");
            await db
              .prepare("DELETE FROM post_comments WHERE post_id=?")
              .run(Number(postMatch[1]));
            await db
              .prepare("DELETE FROM posts WHERE id=?")
              .run(Number(postMatch[1]));
            return send(200, { ok: true });
          }
          // One shared room per day; open 09:00–13:00 KST. Clients poll with ?after=<last id>.
          const chatOpen = clock.minute >= 540 && clock.minute < 780;
          if (path === "/api/chat" && req.method === "GET") {
            const after = url.searchParams.get("after");
            if (after !== null && !/^\d{1,12}$/.test(after))
              fail(400, "요청 형식을 확인해주세요.");
            const columns =
              "SELECT c.id,c.user_id,c.body,c.created_at,u.name,u.track FROM chat_messages c JOIN users u ON u.id=c.user_id";
            const messages =
              after === null
                ? (
                    await db
                      .prepare(
                        `${columns} WHERE c.day=? AND c.deleted=0 ORDER BY c.id DESC LIMIT 200`,
                      )
                      .all(clock.day)
                  ).reverse()
                : await db
                    .prepare(
                      `${columns} WHERE c.day=? AND c.deleted=0 AND c.id>? ORDER BY c.id LIMIT 200`,
                    )
                    .all(clock.day, Number(after));
            const deletedIds =
              after === null
                ? []
                : (
                    await db
                      .prepare(
                        "SELECT id FROM chat_messages WHERE day=? AND deleted=1 AND id<=?",
                      )
                      .all(clock.day, Number(after))
                  ).map((row) => row.id);
            return send(200, {
              day: clock.day,
              open: chatOpen,
              messages,
              deletedIds,
            });
          }
          if (path === "/api/chat" && req.method === "POST") {
            if (!chatOpen)
              fail(409, "채팅은 오전 9시부터 오후 1시까지 이용할 수 있어요.");
            const text = cleanText(body.body, 300, "메시지");
            const recent = await db
              .prepare(
                "SELECT created_at FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 1",
              )
              .get(user.id);
            if (
              recent &&
              now().getTime() - Date.parse(recent.created_at) < 2000
            )
              fail(429, "메시지는 2초 간격으로 보낼 수 있어요.");
            const message = await db
              .prepare(
                "INSERT INTO chat_messages(user_id,day,body,created_at) VALUES (?,?,?,?) RETURNING id",
              )
              .get(user.id, clock.day, text, now().toISOString());
            return send(201, { id: message.id });
          }
          const chatMatch = path.match(/^\/api\/chat\/(\d+)$/);
          if (chatMatch && req.method === "DELETE") {
            const message = await db
              .prepare(
                "SELECT user_id FROM chat_messages WHERE id=? AND deleted=0",
              )
              .get(Number(chatMatch[1]));
            if (!message) fail(404, "메시지를 찾을 수 없습니다.");
            if (message.user_id !== user.id && user.role !== "admin")
              fail(403, "작성자 또는 운영진만 삭제할 수 있습니다.");
            // Soft delete so polling clients learn which messages to remove.
            await db
              .prepare("UPDATE chat_messages SET deleted=1,body='' WHERE id=?")
              .run(Number(chatMatch[1]));
            return send(200, { ok: true });
          }
          if (path.startsWith("/api/admin/")) {
            requireAdmin();
            if (path === "/api/admin/missions" && req.method === "GET")
              return send(200, await adminMissions(db));
            if (path === "/api/admin/missions/review" && req.method === "POST")
              return send(
                200,
                await reviewMission(db, user, body, now(), fail),
              );
            if (path === "/api/admin/missions/event" && req.method === "POST") {
              if (typeof body.active !== "boolean")
                fail(400, "접수 상태를 확인해주세요.");
              const eventId = body.eventId ?? 1;
              if (!Number.isInteger(eventId))
                fail(400, "이벤트를 확인해주세요.");
              const result = await db
                .prepare("UPDATE mission_event SET active=? WHERE id=?")
                .run(body.active ? 1 : 0, eventId);
              if (!result.changes) fail(404, "이벤트를 찾을 수 없습니다.");
              return send(200, { ok: true });
            }
            if (path === "/api/admin/missions/save" && req.method === "POST")
              return send(200, await saveEvent(db, body, now(), fail));
            if (path === "/api/admin/overview" && req.method === "GET") {
              const day = url.searchParams.get("day") || clock.day;
              if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
                fail(400, "날짜 형식이 올바르지 않습니다.");
              const restaurants = await db
                .prepare(
                  `SELECT r.*,COUNT(b.id) count FROM restaurants r LEFT JOIN reservations b ON b.restaurant_id=r.id AND b.day=? GROUP BY r.id ORDER BY r.id`,
                )
                .all(day);
              const reservations = await db
                .prepare(
                  "SELECT b.id,u.name,u.login_id,u.track,r.name restaurant,COALESCE(mi.name,NULLIF(b.menu_note,'')) menu,a.name actual_restaurant,m.reason change_reason FROM reservations b JOIN users u ON u.id=b.user_id JOIN restaurants r ON r.id=b.restaurant_id LEFT JOIN menu_items mi ON mi.id=b.menu_item_id LEFT JOIN meal_records m ON m.user_id=b.user_id AND m.day=b.day LEFT JOIN restaurants a ON a.id=m.restaurant_id WHERE b.day=? ORDER BY r.id,u.track,u.name",
                )
                .all(day);
              const users = await db
                .prepare(
                  "SELECT id,name,login_id,track,role,active,must_change FROM users ORDER BY id",
                )
                .all();
              const tracks = (
                await db.prepare("SELECT name FROM tracks ORDER BY name").all()
              ).map((t) => t.name);
              return send(200, {
                restaurants,
                reservations,
                users,
                tracks,
                day,
              });
            }
            if (path === "/api/admin/restaurants" && req.method === "POST") {
              const name = cleanText(body.name, 60, "식당 이름");
              if (
                typeof body.description !== "string" ||
                body.description.length > 300 ||
                typeof body.menu !== "string" ||
                body.menu.length > 200
              )
                fail(400, "식당 안내 또는 메뉴가 너무 깁니다.");
              const category = body.category ?? null;
              if (
                category !== null &&
                ![
                  "",
                  "중식",
                  "한식",
                  "국밥",
                  "돈가스",
                  "칼국수",
                  "분식",
                  "파스타",
                  "비빔밥",
                  "꼬마김밥",
                ].includes(category)
              )
                fail(400, "음식 종류를 확인해주세요.");
              let naverUrl = null;
              if (body.naverUrl !== undefined) {
                if (
                  typeof body.naverUrl !== "string" ||
                  body.naverUrl.length > 500
                )
                  fail(400, "네이버 링크를 확인해주세요.");
                naverUrl = body.naverUrl.trim();
                if (naverUrl) {
                  let link;
                  try {
                    link = new URL(naverUrl);
                  } catch {
                    fail(400, "올바른 네이버 링크를 입력해주세요.");
                  }
                  if (
                    link.protocol !== "https:" ||
                    ![
                      "naver.me",
                      "map.naver.com",
                      "m.place.naver.com",
                      "place.naver.com",
                    ].includes(link.hostname) ||
                    link.username ||
                    link.password ||
                    link.port
                  )
                    fail(
                      400,
                      "네이버 지도 또는 플레이스의 HTTPS 링크를 입력해주세요.",
                    );
                  naverUrl = link.href;
                }
              }
              if (typeof body.listed !== "boolean")
                fail(400, "식당 표시 여부를 선택해주세요.");
              if (body.id) {
                const restaurant = await db
                  .prepare("SELECT id FROM restaurants WHERE id=?")
                  .get(body.id);
                if (!restaurant) fail(404, "식당을 찾을 수 없습니다.");
                await db
                  .prepare(
                    "UPDATE restaurants SET name=?,description=?,menu=?,listed=?,naver_url=COALESCE(?,naver_url),category=COALESCE(?,category) WHERE id=?",
                  )
                  .run(
                    name,
                    body.description.trim(),
                    body.menu.trim(),
                    body.listed ? 1 : 0,
                    naverUrl,
                    category,
                    body.id,
                  );
              } else
                await db
                  .prepare(
                    "INSERT INTO restaurants(name,description,menu,listed,naver_url,category,access_token) VALUES (?,?,?,?,?,?,?)",
                  )
                  .run(
                    name,
                    body.description.trim(),
                    body.menu.trim(),
                    body.listed ? 1 : 0,
                    naverUrl || "",
                    category || "",
                    token(),
                  );
              return send(200, { ok: true });
            }
            if (path === "/api/admin/rotate-link" && req.method === "POST") {
              const result = await db
                .prepare("UPDATE restaurants SET access_token=? WHERE id=?")
                .run(token(), body.id);
              if (!result.changes) fail(404, "식당을 찾을 수 없습니다.");
              return send(200, { ok: true });
            }
            if (path === "/api/admin/tracks" && req.method === "POST") {
              const name = cleanText(body.name, 30, "반 이름");
              if (
                await db
                  .prepare("SELECT name FROM tracks WHERE name=?")
                  .get(name)
              )
                fail(409, "이미 등록된 반입니다.");
              await db.prepare("INSERT INTO tracks(name) VALUES (?)").run(name);
              return send(201, { ok: true });
            }
            if (path === "/api/admin/users" && req.method === "POST") {
              const name = cleanText(body.name, 40, "이름"),
                loginId = loginIdOf(body.loginId),
                track = await trackOf(body.track);
              const role = body.role ?? "member";
              if (!["member", "admin"].includes(role))
                fail(400, "권한을 선택해주세요.");
              const password = body.password || token().slice(0, 12);
              if (
                typeof password !== "string" ||
                password.length < 8 ||
                password.length > 128
              )
                fail(400, "초기 비밀번호는 8~128자여야 합니다.");
              if (
                await db
                  .prepare("SELECT id FROM users WHERE login_id=?")
                  .get(loginId)
              )
                fail(409, "이미 등록된 학번/ID입니다.");
              await db
                .prepare(
                  "INSERT INTO users(name,login_id,track,role,password) VALUES (?,?,?,?,?)",
                )
                .run(name, loginId, track, role, passwordHash(password));
              return send(201, { name, loginId, track, password });
            }
            if (path === "/api/admin/user-role" && req.method === "POST") {
              if (
                !Number.isInteger(body.id) ||
                !["member", "admin"].includes(body.role)
              )
                fail(400, "이용자와 권한을 확인해주세요.");
              const target = await db
                .prepare("SELECT id,role FROM users WHERE id=?")
                .get(body.id);
              if (!target) fail(404, "이용자를 찾을 수 없습니다.");
              if (target.id === user.id && body.role !== "admin")
                fail(409, "내 운영진 권한은 변경할 수 없습니다.");
              if (
                target.role === "admin" &&
                body.role === "member" &&
                (
                  await db
                    .prepare(
                      "SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1",
                    )
                    .get()
                ).n <= 1
              )
                fail(409, "최소 한 명의 운영진이 필요합니다.");
              await db
                .prepare("UPDATE users SET role=? WHERE id=?")
                .run(body.role, body.id);
              await db
                .prepare("DELETE FROM sessions WHERE user_id=?")
                .run(body.id);
              return send(200, { ok: true });
            }
            if (path === "/api/admin/reset-password" && req.method === "POST") {
              const target = await db
                .prepare("SELECT id,name,login_id,track FROM users WHERE id=?")
                .get(body.id);
              if (!target) fail(404, "이용자를 찾을 수 없습니다.");
              if (target.id === user.id)
                fail(400, "내 비밀번호는 상단 이름 버튼에서 변경해주세요.");
              const password = token().slice(0, 12);
              await db
                .prepare("UPDATE users SET password=?,must_change=1 WHERE id=?")
                .run(passwordHash(password), target.id);
              await db
                .prepare("DELETE FROM sessions WHERE user_id=?")
                .run(target.id);
              return send(200, {
                ...target,
                password,
                loginId: target.login_id,
              });
            }
            if (path === "/api/admin/bulk-users" && req.method === "POST") {
              if (
                !Array.isArray(body.members) ||
                !body.members.length ||
                body.members.length > 100
              )
                fail(400, "한 번에 1~100명을 등록할 수 있습니다.");
              const ids = new Set();
              const members = [];
              for (const member of body.members) {
                if (!member || typeof member !== "object")
                  fail(400, "명단 형식을 확인해주세요.");
                const name = cleanText(member.name, 40, "이름"),
                  loginId = loginIdOf(member.loginId),
                  track = await trackOf(member.track);
                if (
                  ids.has(loginId) ||
                  (await db
                    .prepare("SELECT id FROM users WHERE login_id=?")
                    .get(loginId))
                )
                  fail(
                    409,
                    `${loginId}: 중복되거나 이미 등록된 학번/ID입니다.`,
                  );
                ids.add(loginId);
                members.push({
                  name,
                  loginId,
                  track,
                  password: token().slice(0, 12),
                });
              }

              {
                for (const member of members)
                  await db
                    .prepare(
                      "INSERT INTO users(name,login_id,track,role,password) VALUES (?,?,?,'member',?)",
                    )
                    .run(
                      member.name,
                      member.loginId,
                      member.track,
                      passwordHash(member.password),
                    );
              }
              return send(201, { members });
            }
          }
          fail(404, "요청을 찾을 수 없습니다.");
        },
        { readOnly: req.method === "GET" },
      );
      respond(result);
    } catch (error) {
      if (!error.status)
        console.error("Request error:", error.code || error.name);
      if (error.code === "23505" || error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        error.status = 409;
        error.message = "이미 등록된 정보입니다. 다시 확인해주세요.";
      }
      if (!res.headersSent)
        respond(
          send(
            error.status || 500,
            error.status
              ? { error: error.message }
              : {
                  error:
                    "처리 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.",
                },
          ),
        );
      else res.end();
    }
  };
  const server = http.createServer(handler);
  return { server, db, handler };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { server, db } = createApp();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.HOST || "0.0.0.0", () =>
    console.log(`Lunchpass listening on port ${port}. Timezone: Asia/Seoul.`),
  );
  const stop = () =>
    server.close(() => {
      db.close().then(() => process.exit(0));
    });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

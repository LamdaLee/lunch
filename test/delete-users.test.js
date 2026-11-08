import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, testPassword } from "./helpers.js";

const login = (app, loginId) =>
  app.request("/login", {
    method: "POST",
    body: { loginId, password: testPassword },
  });

test("운영진은 이용자를 기록과 함께 삭제할 수 있다", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const admin = await login(app, "admin");
  const student = await login(app, "ax001");
  const other = await login(app, "sf001");
  const id = async (loginId) =>
    (await app.db.prepare("SELECT id FROM users WHERE login_id=?").get(loginId))
      .id;
  const ax = await id("ax001"),
    sf = await id("sf001"),
    adminId = await id("admin");

  // 학생 기록: 예약(관리자와 일행), 게시글(관리자 댓글), 채팅
  const now = "2026-10-12T10:00:00+09:00";
  const add = (sql, ...args) => app.db.prepare(sql).run(...args);
  await add(
    "INSERT INTO reservations(user_id,restaurant_id,day,created_at) VALUES (?,1,'2026-10-12',?),(?,1,'2026-10-12',?)",
    adminId,
    now,
    ax,
    now,
  );
  const adminRes = await app.db
    .prepare("SELECT id FROM reservations WHERE user_id=?")
    .get(adminId);
  await add("UPDATE reservations SET party_id=?", adminRes.id);
  await add(
    "INSERT INTO posts(user_id,body,created_at) VALUES (?,'학생 글',?)",
    ax,
    now,
  );
  const post = await app.db.prepare("SELECT id FROM posts").get();
  await add(
    "INSERT INTO post_comments(post_id,user_id,body,created_at) VALUES (?,?,'운영진 댓글',?)",
    post.id,
    adminId,
    now,
  );
  await add(
    "INSERT INTO chat_messages(user_id,day,body,created_at) VALUES (?,'2026-10-12','안녕',?)",
    ax,
    now,
  );

  const del = (cookie, ids) =>
    app.request("/admin/delete-users", {
      method: "POST",
      cookie,
      body: { ids },
    });
  // 일반 이용자는 쓸 수 없음
  assert.equal((await del(other.cookie, [ax])).status, 403);
  // 자기 자신은 삭제 불가, 없는 이용자는 404, 잘못된 입력은 400
  assert.equal((await del(admin.cookie, [adminId])).status, 409);
  assert.equal((await del(admin.cookie, [ax, 99999])).status, 404);
  assert.equal((await del(admin.cookie, [])).status, 400);
  assert.equal((await del(admin.cookie, ["1"])).status, 400);

  const result = await del(admin.cookie, [ax, sf]);
  assert.equal(result.status, 200);
  assert.equal(result.data.deleted, 2);
  const count = async (sql, ...args) =>
    Number((await app.db.prepare(sql).get(...args)).n);
  assert.equal(
    await count("SELECT COUNT(*) n FROM users WHERE id IN (?,?)", ax, sf),
    0,
  );
  assert.equal(await count("SELECT COUNT(*) n FROM posts"), 0);
  assert.equal(await count("SELECT COUNT(*) n FROM post_comments"), 0);
  assert.equal(await count("SELECT COUNT(*) n FROM chat_messages"), 0);
  // 관리자 예약은 남고, 혼자 남은 일행은 풀린다
  const left = await app.db
    .prepare("SELECT user_id,party_id FROM reservations")
    .all();
  assert.deepEqual(
    left.map((r) => [r.user_id, r.party_id]),
    [[adminId, null]],
  );
  // 삭제된 학생의 로그인은 끊기고 다시 로그인할 수 없다
  assert.equal(
    (await app.request("/status", { cookie: student.cookie })).data.user ??
      null,
    null,
  );
  assert.equal((await login(app, "ax001")).status, 401);
  // 같은 학번으로 다시 등록할 수 있다
  const again = await app.request("/admin/users", {
    method: "POST",
    cookie: admin.cookie,
    body: { name: "AX학생", loginId: "ax001", track: "AX", role: "member" },
  });
  assert.equal(again.status, 201);
});

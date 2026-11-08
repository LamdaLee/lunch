import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, testPassword } from "./helpers.js";
import { passwordHash } from "../lib/store.js";
import { requestSignature } from "../lib/portal.js";

const login = (app, loginId, password = testPassword) =>
  app.request("/login", { method: "POST", body: { loginId, password } });

test("학번/ID 또는 이름으로 로그인, 동명이인은 비밀번호로 구분", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  // 학번/ID 로그인은 그대로
  assert.equal((await login(app, "ax001")).status, 200);
  // 이름으로 로그인
  const byName = await login(app, "AX학생");
  assert.equal(byName.status, 200);
  assert.equal(
    (await app.request("/status", { cookie: byName.cookie })).data.user
      .login_id,
    "ax001",
  );
  assert.equal((await login(app, " AX학생 ")).status, 200);
  assert.equal((await login(app, "AX학생", "wrong-password")).status, 401);
  assert.equal((await login(app, "없는사람")).status, 401);

  // 동명이인: 비밀번호가 맞는 사람으로 로그인
  const add = app.db.prepare(
    "INSERT INTO users(name,login_id,track,role,password,must_change) VALUES (?,?,?,'member',?,0)",
  );
  await add.run("김민수", "dm001", "DM", passwordHash("minsu-one-pass"));
  await add.run("김민수", "dm002", "DM", passwordHash("minsu-two-pass"));
  const one = await login(app, "김민수", "minsu-one-pass");
  const two = await login(app, "김민수", "minsu-two-pass");
  assert.equal(
    (await app.request("/status", { cookie: one.cookie })).data.user.login_id,
    "dm001",
  );
  assert.equal(
    (await app.request("/status", { cookie: two.cookie })).data.user.login_id,
    "dm002",
  );
  // 비밀번호까지 같으면 ID로 로그인하라고 안내
  await add.run("이서연", "ax101", "AX", passwordHash("same-pass-123"));
  await add.run("이서연", "ax102", "AX", passwordHash("same-pass-123"));
  const both = await login(app, "이서연", "same-pass-123");
  assert.equal(both.status, 409);
  assert.match(both.data.error, /학번\/ID로 로그인/);
  assert.equal((await login(app, "ax102", "same-pass-123")).status, 200);
});

test("이름 로그인에도 시도 제한이 적용된다", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  for (let i = 0; i < 15; i++)
    assert.equal((await login(app, "SF학생", "wrong-password")).status, 401);
  assert.equal((await login(app, "SF학생")).status, 429);
});

test("학번 없이 등록하면 반 이름으로 ID를 자동으로 만든다", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const admin = await app.login("테스트관리자");
  const one = await app.request("/admin/users", {
    method: "POST",
    cookie: admin,
    body: { name: "홍길동", track: "DM" },
  });
  assert.equal(one.status, 201);
  assert.equal(one.data.loginId, "dm001");
  const blank = await app.request("/admin/users", {
    method: "POST",
    cookie: admin,
    body: { name: "박서준", loginId: "  ", track: "DM" },
  });
  assert.equal(blank.data.loginId, "dm002");
  const bulk = await app.request("/admin/bulk-users", {
    method: "POST",
    cookie: admin,
    body: {
      members: [
        { name: "김민지", track: "AX" },
        { name: "이도윤", track: "AX" },
        { name: "최하은", loginId: "", track: "DM" },
        { name: "정우진", loginId: "DM2026777", track: "DM" },
      ],
    },
  });
  assert.equal(bulk.status, 201);
  assert.deepEqual(
    bulk.data.members.map((m) => m.loginId),
    ["ax002", "ax003", "dm003", "DM2026777"], // ax001 은 이미 있는 계정,
  );
  // 자동 ID의 초기 비밀번호로 이름 로그인 → 첫 비밀번호 변경 단계
  const first = await login(app, "김민지", bulk.data.members[0].password);
  assert.equal(first.status, 200);
  assert.equal(
    (await app.request("/status", { cookie: first.cookie })).data.user
      .must_change,
    1,
  );
});

test("포털 로그인도 이름으로 된다", async (t) => {
  const portal = { url: "https://portal.example.com", secret: "p".repeat(40) };
  const app = await fixture({ portal });
  t.after(() => app.close());
  const NOW = Date.parse("2026-10-12T10:00:00+09:00");
  const raw = JSON.stringify({ loginId: "AX학생", password: testPassword });
  const r = await fetch(app.base + "/api/portal/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-portal-ts": String(NOW),
      "x-portal-signature": requestSignature(
        portal.secret,
        "POST",
        "/api/portal/login",
        NOW,
        raw,
      ),
    },
    body: raw,
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).user.loginId, "ax001");
});

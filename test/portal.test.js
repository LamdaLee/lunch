import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, testPassword } from "./helpers.js";
import { requestSignature, signToken } from "../lib/portal.js";
import { passwordHash } from "../lib/store.js";

const portal = { url: "https://portal.example.com", secret: "p".repeat(40) };
const NOW = Date.parse("2026-10-12T10:00:00+09:00"); // fixture 기본 시각

// 포털 서버가 보내는 것처럼 서명한 요청
async function signed(
  app,
  method,
  path,
  body,
  { secret = portal.secret, ts = NOW, signPath = path } = {},
) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const r = await fetch(app.base + path, {
    method,
    headers: {
      ...(raw ? { "Content-Type": "application/json" } : {}),
      "x-portal-ts": String(ts),
      "x-portal-signature": requestSignature(secret, method, signPath, ts, raw),
    },
    body: raw || undefined,
  });
  return { status: r.status, data: await r.json() };
}
async function enter(app, payload, secret = portal.secret) {
  const token = signToken(secret, "enter", payload);
  const r = await fetch(
    `${app.base}/api/portal/enter?token=${encodeURIComponent(token)}`,
    { redirect: "manual" },
  );
  return {
    status: r.status,
    location: r.headers.get("location"),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}

test("포털 연결이 설정되지 않으면 포털 기능은 없다", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  assert.equal((await app.request("/status")).data.portalUrl, null);
  assert.equal(
    (
      await signed(app, "POST", "/api/portal/login", {
        loginId: "ax001",
        password: testPassword,
      })
    ).status,
    404,
  );
  assert.equal(
    (await enter(app, { sub: 2, jti: randomUUID(), exp: NOW + 60000 })).status,
    404,
  );
});

test("포털 서버만 학번·비밀번호를 확인할 수 있다", async (t) => {
  const app = await fixture({ portal });
  t.after(() => app.close());
  assert.equal((await app.request("/status")).data.portalUrl, portal.url);
  const ok = await signed(app, "POST", "/api/portal/login", {
    loginId: "ax001",
    password: testPassword,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(
    { ...ok.data.user, id: undefined },
    {
      id: undefined,
      name: "AX학생",
      loginId: "ax001",
      track: "AX",
      role: "member",
      mustChange: false,
    },
  );
  assert.equal(JSON.stringify(ok.data).includes("password"), false);
  // 틀린 비밀번호
  assert.equal(
    (
      await signed(app, "POST", "/api/portal/login", {
        loginId: "ax001",
        password: "wrong-password",
      })
    ).status,
    401,
  );
  // 서명이 없거나 다르거나 오래되면 거절
  assert.equal(
    (
      await app.request("/portal/login", {
        method: "POST",
        body: { loginId: "ax001", password: testPassword },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await signed(
        app,
        "POST",
        "/api/portal/login",
        { loginId: "ax001", password: testPassword },
        { secret: "x".repeat(40) },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await signed(
        app,
        "POST",
        "/api/portal/login",
        { loginId: "ax001", password: testPassword },
        { ts: NOW - 10 * 60000 },
      )
    ).status,
    401,
  );
  // 본문을 바꾸면 서명이 맞지 않는다
  const raw = JSON.stringify({ loginId: "ax001", password: testPassword });
  const tampered = await fetch(app.base + "/api/portal/login", {
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
    body: JSON.stringify({ loginId: "admin", password: testPassword }),
  });
  assert.equal(tampered.status, 401);
});

test("틀린 비밀번호 시도 제한은 포털 로그인에도 적용되고 기록이 남는다", async (t) => {
  const app = await fixture({ portal });
  t.after(() => app.close());
  for (let i = 0; i < 15; i++)
    assert.equal(
      (
        await signed(app, "POST", "/api/portal/login", {
          loginId: "sf001",
          password: "wrong-password",
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await signed(app, "POST", "/api/portal/login", {
        loginId: "sf001",
        password: testPassword,
      })
    ).status,
    429,
  );
  // 런치패스 로그인 화면도 같은 제한을 공유
  assert.equal(
    (
      await app.request("/login", {
        method: "POST",
        body: { loginId: "sf001", password: testPassword },
      })
    ).status,
    429,
  );
});

test("첫 로그인은 포털에서 비밀번호를 바꾼다", async (t) => {
  const app = await fixture({ portal });
  t.after(() => app.close());
  await app.db
    .prepare(
      "INSERT INTO users(name,login_id,track,role,password,must_change) VALUES (?,?,?,'member',?,1)",
    )
    .run("새학생", "dm001", "DM", passwordHash("1234"));
  const first = await signed(app, "POST", "/api/portal/login", {
    loginId: "dm001",
    password: "1234",
  });
  assert.equal(first.data.user.mustChange, true);
  assert.equal(
    (
      await signed(app, "POST", "/api/portal/password", {
        loginId: "dm001",
        password: "1234",
        newPassword: "short",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await signed(app, "POST", "/api/portal/password", {
        loginId: "dm001",
        password: "9999",
        newPassword: "new-password-1",
      })
    ).status,
    401,
  );
  const changed = await signed(app, "POST", "/api/portal/password", {
    loginId: "dm001",
    password: "1234",
    newPassword: "new-password-1",
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.mustChange, false);
  // 이제 4자리 초기 비밀번호는 안 되고 새 비밀번호로 런치패스에도 로그인된다
  assert.equal(
    (
      await signed(app, "POST", "/api/portal/login", {
        loginId: "dm001",
        password: "1234",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await app.request("/login", {
        method: "POST",
        body: { loginId: "dm001", password: "new-password-1" },
      })
    ).status,
    200,
  );
});

test("포털 점심 탭: 1회용 토큰으로 런치패스에 자동 로그인", async (t) => {
  const app = await fixture({ portal });
  t.after(() => app.close());
  const users = (await signed(app, "GET", "/api/portal/users")).data.users;
  const ax = users.find((u) => u.loginId === "ax001");
  const payload = { sub: ax.id, jti: randomUUID(), exp: NOW + 120000 };
  const r = await enter(app, payload);
  assert.equal(r.status, 302);
  assert.equal(r.location, "/");
  assert.match(r.cookie, /^sid=/);
  const status = await app.request("/status", { cookie: r.cookie });
  assert.equal(status.data.user.name, "AX학생");
  // 같은 토큰은 다시 못 쓴다
  const again = await enter(app, payload);
  assert.equal(again.location, "/?portal=expired");
  assert.equal(again.cookie, undefined);
  // 만료·위조 토큰
  assert.equal(
    (await enter(app, { sub: ax.id, jti: randomUUID(), exp: NOW - 1 }))
      .location,
    "/?portal=expired",
  );
  assert.equal(
    (
      await enter(
        app,
        { sub: ax.id, jti: randomUUID(), exp: NOW + 60000 },
        "x".repeat(40),
      )
    ).location,
    "/?portal=expired",
  );
  const bad = await fetch(`${app.base}/api/portal/enter?token=garbage`, {
    redirect: "manual",
  });
  assert.equal(bad.headers.get("location"), "/?portal=expired");
});

test("포털 서버만 서명으로 명단을 조회할 수 있다", async (t) => {
  const app = await fixture({ portal });
  t.after(() => app.close());
  assert.equal((await app.request("/portal/users")).status, 401);
  const admin = await app.login("테스트관리자");
  assert.equal(
    (await app.request("/portal/users", { cookie: admin })).status,
    401,
  );
  const all = await signed(app, "GET", "/api/portal/users");
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.users.map((u) => u.loginId).sort(), [
    "admin",
    "ax001",
    "sf001",
    "staff001",
  ]);
  assert.equal(all.data.users.find((u) => u.loginId === "admin").role, "admin");
  const id = all.data.users.find((u) => u.loginId === "ax001").id;
  const one = await signed(app, "GET", `/api/portal/users?id=${id}`);
  assert.deepEqual(
    one.data.users.map((u) => u.name),
    ["AX학생"],
  );
  // 서명한 경로와 다른 id 는 거절
  assert.equal(
    (
      await signed(app, "GET", `/api/portal/users?id=${id + 1}`, undefined, {
        signPath: `/api/portal/users?id=${id}`,
      })
    ).status,
    401,
  );
});

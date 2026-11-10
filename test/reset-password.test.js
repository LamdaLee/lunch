import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, testPassword } from "./helpers.js";

test("비밀번호 초기화 때 운영진이 숫자 4자리를 정할 수 있다", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const admin = await app.request("/login", {
    method: "POST",
    body: { loginId: "admin", password: testPassword },
  });
  const { id } = await app.db
    .prepare("SELECT id FROM users WHERE login_id='ax001'")
    .get();
  const reset = (password) =>
    app.request("/admin/reset-password", {
      method: "POST",
      cookie: admin.cookie,
      body: { id, ...(password === undefined ? {} : { password }) },
    });
  for (const bad of ["123", "12345", "abcd", "short"])
    assert.equal((await reset(bad)).status, 400, bad);

  const result = await reset("0427");
  assert.equal(result.status, 200);
  assert.equal(result.data.password, "0427");
  // 학번으로도, 이름으로도 4자리로 로그인되고 첫 로그인 비밀번호 변경이 걸린다
  for (const loginId of ["ax001", "AX학생"]) {
    const login = await app.request("/login", {
      method: "POST",
      body: { loginId, password: "0427" },
    });
    assert.equal(login.status, 200, loginId);
    assert.equal(
      (await app.request("/status", { cookie: login.cookie })).data.user
        .must_change,
      1,
    );
  }
  // 값을 안 주면 예전처럼 자동 비밀번호
  const auto = await reset();
  assert.equal(auto.status, 200);
  assert.ok(auto.data.password.length >= 8);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, testPassword } from "./helpers.js";
import { koreaClock } from "../lib/store.js";

test("한국 시간으로 09:00 개시, 12:00 정각 예약·취소 마감", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const cookie = await app.login("AX학생");
  const reserve = () =>
    app.request("/choice", {
      method: "POST",
      cookie,
      body: { restaurantId: 1 },
    });
  app.setTime("2026-10-12T08:59:59+09:00");
  assert.equal((await reserve()).status, 409);
  app.setTime("2026-10-12T09:00:00+09:00");
  assert.equal((await reserve()).status, 200);
  app.setTime("2026-10-12T11:59:59+09:00");
  assert.equal(
    (await app.request("/choice", { method: "DELETE", cookie, body: {} }))
      .status,
    200,
  );
  assert.equal((await reserve()).status, 200);
  app.setTime("2026-10-12T12:00:00+09:00");
  assert.equal(
    (await app.request("/choice", { method: "DELETE", cookie, body: {} }))
      .status,
    409,
  );
  assert.equal(
    (
      await app.request("/choice", {
        method: "POST",
        cookie,
        body: { restaurantId: 2 },
      })
    ).status,
    409,
  );
  assert.equal(
    (await app.request("/dashboard", { cookie })).data.reservation
      .restaurant_id,
    1,
  );
});
test("최초 관리자는 설정 키로 한 번만 생성 가능", async (t) => {
  const oldKey = process.env.SETUP_KEY;
  process.env.SETUP_KEY = "test-only-bootstrap-key-62481739";
  t.after(() => {
    if (oldKey === undefined) delete process.env.SETUP_KEY;
    else process.env.SETUP_KEY = oldKey;
  });
  const app = await fixture({ seed: false });
  t.after(() => app.close());
  const body = {
    key: process.env.SETUP_KEY,
    name: "운영관리자",
    loginId: "admin",
    password: testPassword,
  };
  assert.equal(
    (
      await app.request("/setup", {
        method: "POST",
        body: { ...body, key: "wrong" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await app.request("/setup", { method: "POST", body })).status,
    201,
  );
  assert.equal(
    (await app.request("/setup", { method: "POST", body })).status,
    409,
  );
  const cookie = (
    await app.request("/login", {
      method: "POST",
      body: { loginId: "admin", password: testPassword },
    })
  ).cookie;
  assert.equal((await app.request("/admin/overview", { cookie })).status, 200);
  assert.equal((await app.request("/status")).data.setupNeeded, false);
});
test("로그인 실패 제한이 DB에 남아 비밀번호 대입을 제한", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  for (let i = 0; i < 15; i++)
    assert.equal(
      (
        await app.request("/login", {
          method: "POST",
          body: { loginId: "ax001", password: "wrong-test-password" },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await app.request("/login", {
        method: "POST",
        body: { loginId: "ax001", password: testPassword },
      })
    ).status,
    429,
  );
  app.setTime("2026-10-12T10:11:00+09:00");
  assert.equal(
    (
      await app.request("/login", {
        method: "POST",
        body: { loginId: "ax001", password: testPassword },
      })
    ).status,
    200,
  );
});
test("시간대는 UTC 호스트에서도 Asia/Seoul 기준", () => {
  assert.deepEqual(koreaClock(new Date("2026-10-11T15:10:00Z")), {
    day: "2026-10-12",
    minute: 10,
    phase: "before",
    label: "00:10",
    timezone: "Asia/Seoul",
  });
});
test("같은 식당을 동시에 선택해도 인원 제한 없이 두 명 모두 집계", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const ax = await app.login("AX학생"),
    sf = await app.login("SF학생");
  const results = await Promise.all(
    [ax, sf].map((cookie) =>
      app.request("/choice", {
        method: "POST",
        cookie,
        body: { restaurantId: 2 },
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200]);
  assert.equal(
    (
      await app.db
        .prepare("SELECT COUNT(*) n FROM reservations WHERE restaurant_id=2")
        .get()
    ).n,
    2,
  );
});
test("식당 변경은 한 건만 유지하고 변경 실패 시 기존 예약 보존", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const ax = await app.login("AX학생"),
    sf = await app.login("SF학생");
  const reserve = (cookie, restaurantId) =>
    app.request("/choice", {
      method: "POST",
      cookie,
      body: { restaurantId },
    });
  assert.equal((await reserve(ax, 1)).status, 200);
  assert.equal((await reserve(sf, 2)).status, 200);
  await app.db.prepare("UPDATE restaurants SET listed=0 WHERE id=2").run();
  assert.equal((await reserve(ax, 2)).status, 404);
  assert.equal(
    (await app.request("/dashboard", { cookie: ax })).data.reservation
      .restaurant_id,
    1,
  );
  assert.equal((await reserve(ax, 3)).status, 200);
  assert.equal(
    (
      await app.db
        .prepare("SELECT COUNT(*) n FROM reservations WHERE user_id=2")
        .get()
    ).n,
    1,
  );
  assert.equal((await reserve(ax, 3)).status, 409);
});
test("교수·강사·운영진도 학생과 동일하게 예약 가능", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  for (const name of ["테스트관리자", "테스트강사"]) {
    const cookie = await app.login(name);
    assert.equal(
      (
        await app.request("/choice", {
          method: "POST",
          cookie,
          body: { restaurantId: 1 },
        })
      ).status,
      200,
    );
  }
});
test("다음 날 예약과 집계는 이전 날짜와 분리됨", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const cookie = await app.login("AX학생");
  await app.request("/choice", {
    method: "POST",
    cookie,
    body: { restaurantId: 1 },
  });
  app.setTime("2026-10-13T10:00:00+09:00");
  const nextCookie = await app.login("AX학생");
  const dashboard = (await app.request("/dashboard", { cookie: nextCookie }))
    .data;
  assert.equal(dashboard.reservation, null);
  assert.equal(dashboard.restaurants[0].count, 0);
  assert.equal(
    (
      await app.request("/choice", {
        method: "POST",
        cookie: nextCookie,
        body: { restaurantId: 1 },
      })
    ).status,
    200,
  );
  assert.equal(
    (await app.db.prepare("SELECT COUNT(*) n FROM reservations").get()).n,
    2,
  );
});
test("운영진만 명단·식당 설정·계정 등록 기능 접근 가능", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  assert.equal((await app.request("/dashboard")).status, 401);
  const cookie = await app.login("AX학생");
  assert.equal((await app.request("/admin/overview", { cookie })).status, 403);
  assert.equal(
    (
      await app.request("/admin/users", {
        method: "POST",
        cookie,
        body: { name: "새학생", track: "AX" },
      })
    ).status,
    403,
  );
  const admin = await app.login("테스트관리자");
  assert.equal(
    (await app.request("/admin/overview", { cookie: admin })).status,
    200,
  );
});
test("식당 설정 없이 9곳 모두 선택 가능하고 기존 정원은 제한하지 않음", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const ax = await app.login("AX학생"),
    sf = await app.login("SF학생");
  const dashboard = (await app.request("/dashboard", { cookie: ax })).data;
  assert.equal(dashboard.restaurants.length, 9);
  for (const cookie of [ax, sf])
    assert.equal(
      (
        await app.request("/choice", {
          method: "POST",
          cookie,
          body: { restaurantId: 9 },
        })
      ).status,
      200,
    );
  const updated = (await app.request("/dashboard", { cookie: ax })).data;
  const restaurant = updated.restaurants.find((r) => r.id === 9);
  assert.equal(restaurant.count, 2);
  assert.deepEqual(restaurant.totals.map((r) => r.track).sort(), ["AX", "SF"]);
  assert.equal(JSON.stringify(updated.restaurants).includes("AX학생"), false);
  const admin = await app.login("테스트관리자");
  assert.equal(
    (
      await app.request("/restaurant/settings", {
        method: "POST",
        cookie: admin,
        body: { capacity: 0, active: false },
      })
    ).status,
    404,
  );
  assert.equal(
    (await app.db.prepare("SELECT capacity FROM restaurants WHERE id=9").get())
      .capacity,
    0,
  );
});

test("새 반 추가와 계정 비밀번호 초기화", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const cookie = await app.login("테스트관리자"),
    member = await app.login("AX학생");
  assert.equal(
    (
      await app.request("/admin/tracks", {
        method: "POST",
        cookie,
        body: { name: "AX3기" },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await app.request("/admin/users", {
        method: "POST",
        cookie,
        body: { name: "새기수", loginId: "ax3-001", track: "AX3기" },
      })
    ).status,
    201,
  );
  const reset = await app.request("/admin/reset-password", {
    method: "POST",
    cookie,
    body: { id: 2 },
  });
  assert.equal(reset.status, 200);
  assert.equal(
    (await app.request("/dashboard", { cookie: member })).status,
    401,
  );
  const next = await app.request("/login", {
    method: "POST",
    body: { loginId: "ax001", password: reset.data.password },
  });
  assert.equal(next.status, 200);
  assert.equal(
    (await app.request("/status", { cookie: next.cookie })).data.user
      .must_change,
    1,
  );
});
test("식당 링크는 자기 식당 인원만 제공하고 재발급 시 기존 링크 폐기", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const cookie = await app.login("AX학생");
  await app.request("/choice", {
    method: "POST",
    cookie,
    body: { restaurantId: 1 },
  });
  const restaurantToken = (
    await app.db
      .prepare("SELECT access_token FROM restaurants WHERE id=1")
      .get()
  ).access_token;
  const response = await app.request("/restaurant?token=" + restaurantToken);
  assert.equal(response.status, 200);
  assert.equal(response.data.count, 1);
  assert.equal(JSON.stringify(response.data).includes("AX학생"), false);
  assert.equal(response.data.restaurant.access_token, undefined);
  assert.equal((await app.request("/restaurant?token=wrong")).status, 404);
  const admin = await app.login("테스트관리자");
  await app.request("/admin/rotate-link", {
    method: "POST",
    cookie: admin,
    body: { id: 1 },
  });
  assert.equal(
    (await app.request("/restaurant?token=" + restaurantToken)).status,
    404,
  );
});
test("관리자가 이름·학번·반을 등록하고 첫 비밀번호 변경을 강제", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const admin = await app.login("테스트관리자");
  const registration = await app.request("/admin/users", {
    method: "POST",
    cookie: admin,
    body: {
      name: "새학생",
      loginId: "new001",
      track: "DM",
      password: testPassword,
    },
  });
  assert.equal(registration.status, 201);
  const login = await app.request("/login", {
    method: "POST",
    body: { loginId: "new001", password: testPassword },
  });
  assert.equal(login.status, 200);
  const cookie = login.cookie;
  const user = (await app.request("/status", { cookie })).data.user;
  assert.equal(user.name, "새학생");
  assert.equal(user.track, "DM");
  assert.equal(user.role, "member");
  assert.equal(user.must_change, 1);
  assert.equal((await app.request("/dashboard", { cookie })).status, 403);
  assert.equal(
    (
      await app.request("/choice", {
        method: "POST",
        cookie,
        body: { restaurantId: 1 },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request("/password", {
        method: "POST",
        cookie,
        body: { current: testPassword, password: "my-new-test-password-12" },
      })
    ).status,
    200,
  );
  assert.equal((await app.request("/dashboard", { cookie })).status, 200);
});
test("일괄 등록은 학번 중복 시 부분 저장 없이 실패하고 동명이인 지원", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const cookie = await app.login("테스트관리자");
  const bad = await app.request("/admin/bulk-users", {
    method: "POST",
    cookie,
    body: {
      members: [
        { name: "신규", loginId: "new001", track: "AX" },
        { name: "다른학생", loginId: "ax001", track: "AX" },
      ],
    },
  });
  assert.equal(bad.status, 409);
  assert.equal(
    (await app.db.prepare("SELECT COUNT(*) n FROM users").get()).n,
    4,
  );
  const ok = await app.request("/admin/bulk-users", {
    method: "POST",
    cookie,
    body: {
      members: [
        { name: "동명이인", loginId: "new001", track: "AX" },
        { name: "동명이인", loginId: "new002", track: "AX2기" },
      ],
    },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.members.length, 2);
  assert.notEqual(ok.data.members[0].password, ok.data.members[1].password);
});
test("게시판은 로그인 필요, 작성자와 운영진만 삭제 가능", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  assert.equal((await app.request("/posts")).status, 401);
  const ax = await app.login("AX학생"),
    sf = await app.login("SF학생");
  const post = await app.request("/posts", {
    method: "POST",
    cookie: ax,
    body: { body: "오늘 점심 추천해요!", pinned: true },
  });
  assert.equal(post.status, 201);
  const item = (await app.request("/posts", { cookie: ax })).data.posts[0];
  assert.equal(item.pinned, 0);
  assert.equal(
    (
      await app.request(`/posts/${item.id}`, {
        method: "DELETE",
        cookie: sf,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request(`/posts/${item.id}`, {
        method: "DELETE",
        cookie: ax,
        body: {},
      })
    ).status,
    200,
  );
});
test("교차 출처 변경 요청 차단 및 로그아웃 세션 무효화", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const cookie = await app.login("AX학생");
  assert.equal(
    (
      await app.request("/choice", {
        method: "POST",
        cookie,
        body: { restaurantId: 1 },
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await app.request("/logout", { method: "POST", cookie, body: {} })).status,
    200,
  );
  assert.equal((await app.request("/dashboard", { cookie })).status, 401);
});
test("비밀번호 변경 후 이전 비밀번호·다른 세션 무효화", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const first = await app.login("AX학생"),
    second = await app.login("AX학생");
  const result = await app.request("/password", {
    method: "POST",
    cookie: first,
    body: { current: testPassword, password: "changed-test-password-91" },
  });
  assert.equal(result.status, 200);
  assert.equal(
    (await app.request("/dashboard", { cookie: second })).status,
    401,
  );
  assert.equal(
    (await app.request("/dashboard", { cookie: first })).status,
    200,
  );
  assert.equal(
    (
      await app.request("/login", {
        method: "POST",
        body: { loginId: "ax001", password: testPassword },
      })
    ).status,
    401,
  );
});
test("서버를 재시작해도 예약·계정·세션 유지", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lunchpass-test-"));
  let app;
  try {
    const path = join(dir, "db.sqlite");
    app = await fixture({ path });
    const cookie = await app.login("AX학생");
    await app.request("/choice", {
      method: "POST",
      cookie,
      body: { restaurantId: 1 },
    });
    await app.db.exec("ALTER TABLE restaurants DROP COLUMN listed");
    await app.close();
    app = null;
    app = await fixture({ path, seed: false });
    const response = await app.request("/dashboard", { cookie });
    assert.equal(response.status, 200);
    assert.equal(response.data.restaurants.length, 9);
    assert.equal(response.data.reservation.restaurant_id, 1);
  } finally {
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("운영진이 식당을 숨겨도 기존 선택은 보존되고 새 식당 추가 가능", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const member = await app.login("AX학생"),
    cookie = await app.login("테스트관리자");
  await app.request("/choice", {
    method: "POST",
    cookie: member,
    body: { restaurantId: 1 },
  });
  assert.equal(
    (
      await app.request("/admin/restaurants", {
        method: "POST",
        cookie,
        body: {
          id: 1,
          name: "한끼식당",
          description: "휴무",
          menu: "",
          listed: false,
        },
      })
    ).status,
    200,
  );
  const data = (await app.request("/dashboard", { cookie: member })).data;
  assert.equal(data.reservation.restaurant_id, 1);
  assert.equal(
    data.restaurants.some((r) => r.id === 1),
    false,
  );
  assert.equal(
    (
      await app.request("/choice", {
        method: "POST",
        cookie: member,
        body: { restaurantId: 1 },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.request("/admin/restaurants", {
        method: "POST",
        cookie,
        body: { name: "새식당", description: "", menu: "", listed: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (await app.db.prepare("SELECT COUNT(*) n FROM restaurants").get()).n,
    10,
  );
});
test("운영진 추가·기존 이용자 권한 변경 및 세션 무효화", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const admin = await app.login("테스트관리자"),
    member = await app.login("AX학생");
  const update = (cookie, id, role) =>
    app.request("/admin/user-role", {
      method: "POST",
      cookie,
      body: { id, role },
    });
  assert.equal((await update(member, 2, "admin")).status, 403);
  assert.equal((await update(admin, 1, "member")).status, 409);
  assert.equal(
    (
      await app.request("/admin/users", {
        method: "POST",
        cookie: admin,
        body: {
          name: "추가운영진",
          loginId: "admin2",
          track: "OTHER",
          role: "admin",
          password: testPassword,
        },
      })
    ).status,
    201,
  );
  const fresh = await app.login("admin2");
  assert.equal(
    (await app.request("/admin/overview", { cookie: fresh })).status,
    403,
  );
  await app.request("/password", {
    method: "POST",
    cookie: fresh,
    body: { current: testPassword, password: "second-admin-password-47" },
  });
  assert.equal(
    (await app.request("/admin/overview", { cookie: fresh })).status,
    200,
  );
  assert.equal((await update(admin, 2, "admin")).status, 200);
  assert.equal(
    (await app.request("/admin/overview", { cookie: member })).status,
    401,
  );
  const promoted = await app.login("AX학생");
  assert.equal(
    (await app.request("/admin/overview", { cookie: promoted })).status,
    200,
  );
  assert.equal((await update(admin, 2, "member")).status, 200);
  assert.equal(
    (await app.request("/admin/overview", { cookie: promoted })).status,
    401,
  );
  const demoted = await app.login("AX학생");
  assert.equal(
    (await app.request("/admin/overview", { cookie: demoted })).status,
    403,
  );
  assert.equal((await update(admin, 2, "invalid")).status, 400);
});

test("내 기록은 본인 선택만 최신 날짜순으로 조회하고 변경·취소를 반영", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  assert.equal((await app.request("/history")).status, 401);
  let ax = await app.login("AX학생"),
    sf = await app.login("SF학생");
  const choose = (cookie, restaurantId) =>
    app.request("/choice", { method: "POST", cookie, body: { restaurantId } });
  await choose(ax, 1);
  await choose(ax, 3);
  await choose(sf, 2);
  app.setTime("2026-10-13T10:00:00+09:00");
  ax = await app.login("AX학생");
  sf = await app.login("SF학생");
  await choose(ax, 9);
  const history = await app.request("/history?userId=3", { cookie: ax });
  assert.equal(history.status, 200);
  assert.deepEqual(history.data.records, [
    { day: "2026-10-13", restaurant: "파스토보이" },
    { day: "2026-10-12", restaurant: "초록테이블" },
  ]);
  assert.equal(history.data.nextBefore, null);
  assert.deepEqual(
    (await app.request("/history?before=2026-10-13", { cookie: ax })).data
      .records,
    [{ day: "2026-10-12", restaurant: "초록테이블" }],
  );
  assert.equal(
    (await app.request("/history?before=bad", { cookie: ax })).status,
    400,
  );
  await app.request("/choice", { method: "DELETE", cookie: ax, body: {} });
  assert.equal(
    (await app.request("/history", { cookie: ax })).data.records.length,
    1,
  );
  assert.deepEqual(
    (await app.request("/history", { cookie: sf })).data.records,
    [{ day: "2026-10-12", restaurant: "온기국수" }],
  );
});
test("이전 기록은 50개씩 중복 없이 조회", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const cookie = await app.login("AX학생");
  const insert = app.db.prepare(
    "INSERT INTO reservations(user_id,restaurant_id,day,created_at) VALUES (2,1,?,?)",
  );
  for (let i = 0; i < 55; i++) {
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    await insert.run(day, day + "T01:00:00Z");
  }
  const first = (await app.request("/history", { cookie })).data;
  assert.equal(first.records.length, 50);
  assert.equal(first.nextBefore, first.records.at(-1).day);
  const second = (
    await app.request("/history?before=" + first.nextBefore, { cookie })
  ).data;
  assert.equal(second.records.length, 5);
  assert.equal(second.nextBefore, null);
  assert.equal(
    new Set([...first.records, ...second.records].map((r) => r.day)).size,
    55,
  );
});

test("네이버 링크 등록은 운영진만 가능하며 잘못된 주소를 저장하지 않음", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const admin = await app.login("테스트관리자"),
    member = await app.login("AX학생");
  const save = (cookie, naverUrl) =>
    app.request("/admin/restaurants", {
      method: "POST",
      cookie,
      body: {
        id: 1,
        name: "한끼식당",
        description: "",
        menu: "",
        listed: true,
        naverUrl,
      },
    });
  assert.equal((await save(member, "https://naver.me/xIeXiYYf")).status, 403);
  for (const url of [
    "javascript:alert(1)",
    "https://evil.example/",
    "https://naver.me.evil.example/",
    "https://user:password@naver.me/x",
  ])
    assert.equal((await save(admin, url)).status, 400);
  assert.equal((await save(admin, "https://naver.me/xIeXiYYf")).status, 200);
  assert.equal(
    (await app.request("/dashboard", { cookie: member })).data.restaurants[0]
      .naver_url,
    "https://naver.me/xIeXiYYf",
  );
  assert.equal((await save(admin, "")).status, 200);
  assert.equal(
    (await app.request("/dashboard", { cookie: member })).data.restaurants[0]
      .naver_url,
    "",
  );
});

test("오늘 게시판 제목은 한국 시간 자정 기준으로만 포함하고 글 내용은 별도 조회", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const insert = app.db.prepare(
    "INSERT INTO posts(user_id,title,body,pinned,created_at) VALUES (1,?,?,?,?)",
  );
  await insert.run("지난 공지", "어제 본문", 1, "2026-10-11T14:59:59.000Z");
  await insert.run(
    "오늘 첫 글",
    "본문은 목록에 제외",
    0,
    "2026-10-11T15:00:00.000Z",
  );
  await insert.run(
    "",
    "기존 글 첫 줄\n나머지 본문",
    0,
    "2026-10-12T00:00:00.000Z",
  );
  await insert.run("내일 글", "다음 날 본문", 0, "2026-10-12T15:00:00.000Z");
  const cookie = await app.login("AX학생");
  const posts = (await app.request("/dashboard", { cookie })).data.todayPosts;
  assert.deepEqual(
    posts.map((p) => p.title),
    ["기존 글 첫 줄", "오늘 첫 글"],
  );
  assert.equal(posts[0].body, undefined);
  assert.equal((await app.request("/posts/" + posts[0].id)).status, 401);
  assert.equal(
    (await app.request("/posts/" + posts[0].id, { cookie })).data.post.body,
    "기존 글 첫 줄\n나머지 본문",
  );
  assert.equal((await app.request("/posts/999999", { cookie })).status, 404);
  const created = await app.request("/posts", {
    method: "POST",
    cookie,
    body: { title: "오늘 함께 먹어요", body: "칼국수 3명 가요" },
  });
  assert.equal(created.status, 201);
  const board = (await app.request("/dashboard", { cookie })).data.todayPosts;
  assert.equal(board[0].title, "오늘 함께 먹어요");
});

test("숫자 4자리 초기 비밀번호는 첫 변경 전만 허용하고 개인 비밀번호는 8자리 이상", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const { passwordHash } = await import("../lib/store.js");
  await app.db
    .prepare("UPDATE users SET password=?,must_change=1 WHERE login_id=?")
    .run(passwordHash("0642"), "ax001");
  const login = await app.request("/login", {
    method: "POST",
    body: { loginId: "ax001", password: "0642" },
  });
  assert.equal(login.status, 200);
  assert.equal(
    (await app.request("/dashboard", { cookie: login.cookie })).status,
    403,
  );
  assert.equal(
    (
      await app.request("/password", {
        method: "POST",
        cookie: login.cookie,
        body: { current: "0642", password: "1234" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await app.request("/password", {
        method: "POST",
        cookie: login.cookie,
        body: { current: "0642", password: "changed-personal-password-72" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request("/login", {
        method: "POST",
        body: { loginId: "ax001", password: "0642" },
      })
    ).status,
    401,
  );
  await app.db
    .prepare("UPDATE users SET password=?,must_change=0 WHERE login_id=?")
    .run(passwordHash("1234"), "sf001");
  assert.equal(
    (
      await app.request("/login", {
        method: "POST",
        body: { loginId: "sf001", password: "1234" },
      })
    ).status,
    401,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, testPassword } from "./helpers.js";
import { passwordHash } from "../lib/store.js";
async function setup(t) {
  const app = await fixture();
  t.after(() => app.close());
  await app.db
    .prepare("UPDATE mission_event SET active=1,start_day='2026-10-12'")
    .run();
  return app;
}
async function apply(app, cookie) {
  await app.request("/posts", {
    method: "POST",
    cookie,
    body: { title: "추천합니다", body: "한끼식당 제육 추천해요." },
  });
  const post = (await app.request("/posts", { cookie })).data.posts[0];
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie,
        body: { mission: "recommend", postId: post.id },
      })
    ).status,
    201,
  );
  return (await app.request("/missions", { cookie })).data.claims[0];
}
test("응모는 모든 활성 운영진에게만 알림, 학생·다른 계정에 노출되지 않음", async (t) => {
  const app = await setup(t),
    student = await app.login("AX학생"),
    other = await app.login("SF학생"),
    admin = await app.login("테스트관리자");
  await app.db
    .prepare(
      "INSERT INTO users(name,login_id,track,role,password,must_change) VALUES ('추가운영진','admin2','OTHER','admin',?,0)",
    )
    .run(passwordHash(testPassword));
  const admin2 = await app.login("admin2");
  assert.equal((await app.request("/notifications")).status, 401);
  const entry = await apply(app, student);
  for (const cookie of [admin, admin2]) {
    const data = (await app.request("/notifications", { cookie })).data;
    assert.equal(data.unread, 1);
    assert.equal(data.notifications.length, 1);
    assert.equal(data.notifications[0].target_tab, "admin");
    assert.match(data.notifications[0].body, /AX학생.*ax001/);
  }
  assert.equal(
    (await app.request("/notifications", { cookie: student })).data.unread,
    0,
  );
  assert.equal(
    (await app.request("/notifications", { cookie: other })).data.notifications
      .length,
    0,
  );
  const notification = (await app.request("/notifications", { cookie: admin }))
    .data.notifications[0];
  assert.equal(
    (
      await app.request("/notifications/read", {
        method: "POST",
        cookie: student,
        body: { id: notification.id },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.request("/notifications/read", {
        method: "POST",
        cookie: admin2,
        body: { id: notification.id },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie: student,
        body: { mission: "recommend", postId: entry.post_id },
      })
    ).status,
    409,
  );
  assert.equal(
    (await app.request("/notifications", { cookie: admin })).data.unread,
    1,
  );
});
test("보완 사유는 응모자에게만 전달하고 동일 처리 재시도는 알림을 중복 생성하지 않음", async (t) => {
  const app = await setup(t),
    student = await app.login("AX학생"),
    other = await app.login("SF학생"),
    admin = await app.login("테스트관리자");
  const entry = await apply(app, student),
    body = {
      id: entry.id,
      status: "rejected",
      note: "추천 메뉴와 이유를 추가해주세요.",
    };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await app.request("/admin/missions/review", {
          method: "POST",
          cookie: admin,
          body,
        })
      ).status,
      200,
    );
  let data = (await app.request("/notifications", { cookie: student })).data;
  assert.equal(data.unread, 1);
  assert.equal(data.notifications[0].title, "이벤트 보완 요청");
  assert.match(data.notifications[0].body, /추천 메뉴와 이유를 추가해주세요/);
  assert.equal(
    (await app.request("/notifications", { cookie: other })).data.unread,
    0,
  );
  assert.equal(
    (await app.request("/notifications", { cookie: admin })).data.unread,
    1,
  );
  const n = data.notifications[0];
  const read = await app.request("/notifications/read", {
    method: "POST",
    cookie: student,
    body: { id: n.id },
  });
  assert.equal(read.status, 200);
  assert.equal(read.data.targetTab, "missions");
  assert.equal(read.data.eventId, 1);
  data = (await app.request("/notifications", { cookie: student })).data;
  assert.equal(data.unread, 0);
  assert.ok(data.notifications[0].read_at);
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie: student,
        body: { mission: "recommend", postId: entry.post_id },
      })
    ).status,
    201,
  );
  assert.equal(
    (await app.request("/notifications", { cookie: admin })).data.unread,
    2,
  );
  for (const status of ["approved", "issued"]) {
    await app.request("/admin/missions/review", {
      method: "POST",
      cookie: admin,
      body: { id: entry.id, status },
    });
    await app.request("/admin/missions/review", {
      method: "POST",
      cookie: admin,
      body: { id: entry.id, status },
    });
  }
  data = (await app.request("/notifications", { cookie: student })).data;
  assert.equal(data.unread, 2);
  assert.equal(data.notifications.length, 3);
  await app.request("/notifications/read", {
    method: "POST",
    cookie: student,
    body: { all: true },
  });
  assert.equal(
    (await app.request("/notifications?summary=1", { cookie: student })).data
      .unread,
    0,
  );
  assert.equal(
    (await app.request("/notifications?summary=1", { cookie: admin })).data
      .unread,
    2,
  );
});
test("알림은 50개씩 이전 목록 조회 가능하고 관리자 권한 해제 후 운영 알림은 숨김", async (t) => {
  const app = await setup(t),
    admin = await app.login("테스트관리자");
  const insert = app.db.prepare(
    "INSERT INTO notifications(user_id,title,body,target_tab,event_id,created_at) VALUES (1,?,?,'admin',1,?)",
  );
  for (let i = 0; i < 55; i++)
    await insert.run(
      "응모 알림 " + i,
      "테스트 본문",
      "2026-10-12T01:00:00.000Z",
    );
  const first = (await app.request("/notifications", { cookie: admin })).data;
  assert.equal(first.notifications.length, 50);
  assert.equal(first.unread, 55);
  const second = (
    await app.request("/notifications?before=" + first.nextBefore, {
      cookie: admin,
    })
  ).data;
  assert.equal(second.notifications.length, 5);
  assert.equal(
    new Set([...first.notifications, ...second.notifications].map((n) => n.id))
      .size,
    55,
  );
  assert.equal(
    (await app.request("/notifications?before=invalid", { cookie: admin }))
      .status,
    400,
  );
  await app.db.prepare("UPDATE users SET role='member' WHERE id=1").run();
  assert.equal(
    (await app.request("/notifications", { cookie: admin })).data.notifications
      .length,
    0,
  );
  assert.equal(
    (
      await app.request("/notifications/read", {
        method: "POST",
        cookie: admin,
        body: { id: first.notifications[0].id },
      })
    ).status,
    404,
  );
});

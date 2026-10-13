import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, testPassword } from "./helpers.js";
import { passwordHash, openStore } from "../lib/store.js";
import { createApp } from "../server.js";

async function setup(t) {
  const app = await fixture();
  t.after(() => app.close());
  await app.db
    .prepare("UPDATE mission_event SET start_day=?,active=1")
    .run("2026-10-12");
  return app;
}
async function post(
  app,
  cookie,
  title = "식당 추천",
  body = "한끼식당 제육이 맛있어요",
) {
  const result = await app.request("/posts", {
    method: "POST",
    cookie,
    body: { title, body },
  });
  assert.equal(result.status, 201);
  return (await app.request("/posts", { cookie })).data.posts.find(
    (p) => p.title === title,
  ).id;
}
const claim = (app, cookie, mission, fields = {}) =>
  app.request("/missions/claim", {
    method: "POST",
    cookie,
    body: { mission, ...fields },
  });
const review = (app, cookie, id, status, note) =>
  app.request("/admin/missions/review", {
    method: "POST",
    cookie,
    body: { id, status, note },
  });

test("미션은 학생 본인 글로만 참여하고 추천과 후기는 서로 다른 글, 개인 쿠폰은 비공개", async (t) => {
  const app = await setup(t),
    ax = await app.login("AX학생"),
    sf = await app.login("SF학생"),
    admin = await app.login("테스트관리자"),
    staff = await app.login("테스트강사");
  assert.equal((await app.request("/missions")).status, 401);
  const id = await post(app, ax);
  assert.equal((await claim(app, sf, "recommend", { postId: id })).status, 403);
  assert.equal(
    (await claim(app, staff, "recommend", { postId: id })).status,
    403,
  );
  assert.equal(
    (await claim(app, admin, "recommend", { postId: id })).status,
    403,
  );
  assert.equal((await claim(app, ax, "recommend", { postId: id })).status, 201);
  assert.equal((await claim(app, ax, "recommend", { postId: id })).status, 409);
  assert.equal((await claim(app, ax, "review", { postId: id })).status, 409);
  assert.equal(
    (await app.request("/admin/missions", { cookie: ax })).status,
    403,
  );
  const me = (await app.request("/missions", { cookie: ax })).data;
  assert.equal(me.claims.length, 1);
  assert.equal(
    (await app.request("/missions", { cookie: sf })).data.claims.length,
    0,
  );
  assert.equal(
    (await review(app, ax, me.claims[0].id, "approved")).status,
    403,
  );
  assert.equal(
    (await review(app, admin, me.claims[0].id, "approved")).status,
    200,
  );
  const approved = (await app.request("/missions", { cookie: ax })).data
    .claims[0];
  assert.equal(approved.status, "approved");
  assert.match(approved.coupon_code, /^LP-/);
  assert.equal(
    JSON.stringify(
      (await app.request("/missions", { cookie: sf })).data,
    ).includes(approved.coupon_code),
    false,
  );
});
test("승인과 실제 지급은 별개이고 지급 중복 처리·재참여로 쿠폰을 늘릴 수 없음", async (t) => {
  const app = await setup(t),
    ax = await app.login("AX학생"),
    admin = await app.login("테스트관리자");
  const id = await post(app, ax);
  await claim(app, ax, "recommend", { postId: id });
  const entry = (await app.request("/missions", { cookie: ax })).data.claims[0];
  assert.equal((await review(app, admin, entry.id, "issued")).status, 409);
  await review(app, admin, entry.id, "approved");
  const code = (await app.request("/missions", { cookie: ax })).data.claims[0]
    .coupon_code;
  await review(app, admin, entry.id, "approved");
  assert.equal(
    (await app.request("/missions", { cookie: ax })).data.claims[0].coupon_code,
    code,
  );
  assert.equal((await review(app, admin, entry.id, "issued")).status, 200);
  assert.equal((await review(app, admin, entry.id, "issued")).status, 200);
  assert.equal(
    (await review(app, admin, entry.id, "rejected", "다시")).status,
    409,
  );
  assert.equal((await claim(app, ax, "recommend", { postId: id })).status, 409);
  assert.equal(
    (await app.request("/missions", { cookie: ax })).data.event.missions.find(
      (m) => m.id === "recommend",
    ).used,
    1,
  );
});
test("보완 요청은 자리를 열고 재제출 가능, 접수 중단·재개로 수량을 초기화하지 않음", async (t) => {
  const app = await setup(t),
    ax = await app.login("AX학생"),
    admin = await app.login("테스트관리자");
  const id = await post(app, ax);
  await claim(app, ax, "recommend", { postId: id });
  const entry = (await app.request("/missions", { cookie: ax })).data.claims[0];
  assert.equal(
    (await review(app, admin, entry.id, "rejected", "")).status,
    400,
  );
  await review(
    app,
    admin,
    entry.id,
    "rejected",
    "추천 메뉴와 이유를 추가해주세요.",
  );
  let data = (await app.request("/missions", { cookie: ax })).data;
  assert.equal(data.claims[0].review_note, "추천 메뉴와 이유를 추가해주세요.");
  assert.equal(data.event.missions.find((m) => m.id === "recommend").used, 0);
  assert.equal((await claim(app, ax, "recommend", { postId: id })).status, 201);
  await app.request("/admin/missions/event", {
    method: "POST",
    cookie: admin,
    body: { active: false },
  });
  assert.equal((await claim(app, ax, "review", { postId: id })).status, 409);
  await app.request("/admin/missions/event", {
    method: "POST",
    cookie: admin,
    body: { active: true },
  });
  data = (await app.request("/missions", { cookie: ax })).data;
  assert.equal(data.event.missions.find((m) => m.id === "recommend").used, 1);
  assert.equal(data.claims.length, 1);
});
test("점심 미션은 선택 기록과 식사 완료 확인이 필요하며 당일 오후 2시부터 제출", async (t) => {
  const app = await setup(t),
    cookie = await app.login("AX학생");
  assert.equal(
    (
      await claim(app, cookie, "lunch", {
        day: "2026-10-12",
        confirmedMeal: true,
      })
    ).status,
    409,
  );
  await app.request("/choice", {
    method: "POST",
    cookie,
    body: { restaurantId: 1 },
  });
  app.setTime("2026-10-12T14:00:00+09:00");
  assert.equal(
    (
      await claim(app, cookie, "lunch", {
        day: "2026-10-12",
        confirmedMeal: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await claim(app, cookie, "lunch", {
        day: "2026-10-13",
        confirmedMeal: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await claim(app, cookie, "lunch", {
        day: "2026-10-12",
        confirmedMeal: true,
      })
    ).status,
    201,
  );
  const admin = await app.login("테스트관리자");
  assert.match(
    (await app.request("/admin/missions", { cookie: admin })).data.claims[0]
      .evidence,
    /한끼식당/,
  );
});
test("이벤트 시작일 이전 글은 참여 불가하며 추천·후기 두 미션은 별도 정원", async (t) => {
  const app = await setup(t),
    cookie = await app.login("AX학생");
  const old = await post(app, cookie, "이전 글");
  await app.db
    .prepare("UPDATE posts SET created_at=? WHERE id=?")
    .run("2026-10-11T14:59:59.000Z", old);
  assert.equal(
    (await claim(app, cookie, "recommend", { postId: old })).status,
    400,
  );
  app.setTime("2026-10-12T10:01:00+09:00");
  const first = await post(app, cookie, "추천 글");
  app.setTime("2026-10-12T10:02:00+09:00");
  const second = await post(
    app,
    cookie,
    "후기 글",
    "한끼식당 대기 5분, 맛있어요.",
  );
  assert.equal(
    (await claim(app, cookie, "recommend", { postId: first })).status,
    201,
  );
  assert.equal(
    (await claim(app, cookie, "review", { postId: second })).status,
    201,
  );
  const result = (await app.request("/missions", { cookie })).data;
  assert.equal(result.claims.length, 2);
  assert.deepEqual(
    result.event.missions.map((m) => m.used),
    [0, 1, 1],
  );
});
test("동시 신청 25명 중 정확히 20명만 접수, PostgreSQL은 두 서버에서도 초과하지 않음", async (t) => {
  const app = await setup(t);
  let second, secondDb;
  if (app.db.postgres) {
    secondDb = openStore(app.databasePath);
    await secondDb.ready;
    second = createApp({
      db: secondDb,
      now: () => new Date("2026-10-12T10:00:00+09:00"),
    });
    await new Promise((resolve) =>
      second.server.listen(0, "127.0.0.1", resolve),
    );
    t.after(async () => {
      await new Promise((resolve) => second.server.close(resolve));
      await secondDb.close();
    });
  }
  const jobs = [];
  const hash = passwordHash(testPassword);
  for (let i = 0; i < 25; i++) {
    const loginId = `mission${i}`;
    await app.db
      .prepare(
        "INSERT INTO users(name,login_id,track,role,password,must_change) VALUES (?,?,'AX','member',?,0)",
      )
      .run(`미션학생${i}`, loginId, hash);
    const cookie = await app.login(loginId);
    const id = await post(app, cookie, `추천${i}`);
    const base =
      second && i % 2
        ? `http://127.0.0.1:${second.server.address().port}`
        : app.base;
    jobs.push({ base, cookie, id });
  }
  const result = await Promise.all(
    jobs.map(({ base, cookie, id }) =>
      fetch(base + "/api/missions/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ mission: "recommend", postId: id }),
      }),
    ),
  );
  assert.equal(result.filter((r) => r.status === 201).length, 20);
  assert.equal(result.filter((r) => r.status === 409).length, 5);
  assert.equal(
    (
      await app.db
        .prepare(
          "SELECT COUNT(*) n FROM mission_claims WHERE mission='recommend' AND status<>'rejected'",
        )
        .get()
    ).n,
    20,
  );
  const admin = await app.login("테스트관리자");
  const entries = (await app.request("/admin/missions", { cookie: admin })).data
    .claims;
  await review(app, admin, entries[0].id, "rejected", "추천 내용 보완 필요");
  const failedIndex = result.findIndex((r) => r.status === 409);
  assert.equal(
    (
      await claim(app, jobs[failedIndex].cookie, "recommend", {
        postId: jobs[failedIndex].id,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await app.db
        .prepare(
          "SELECT COUNT(*) n FROM mission_claims WHERE mission='recommend' AND status<>'rejected'",
        )
        .get()
    ).n,
    20,
  );
});

async function event(app, admin, changes = {}) {
  const result = await app.request("/admin/missions/save", {
    method: "POST",
    cookie: admin,
    body: {
      title: "새 응모 이벤트",
      description: "조건을 확인하고 응모하세요.",
      startDay: "2026-10-12",
      endDay: "2026-10-20",
      rewardAmount: 1000,
      missions: [
        {
          kind: "entry",
          title: "조건 확인하고 응모하기",
          description: "참여 조건을 확인하세요.",
          capacity: 1,
          requiresReview: false,
        },
      ],
      ...changes,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const eventId = result.data.eventId;
  await app.request("/admin/missions/event", {
    method: "POST",
    cookie: admin,
    body: { eventId, active: true },
  });
  return (
    await app.request("/admin/missions", { cookie: admin })
  ).data.events.find((e) => e.id === eventId);
}
const editBody = (e) => ({
  id: e.id,
  title: e.title,
  description: e.description,
  startDay: e.start_day,
  endDay: e.end_day,
  rewardAmount: e.reward_amount,
  missions: e.missions.map((m) => ({
    id: m.missionId,
    kind: m.kind,
    title: m.title,
    description: m.description,
    capacity: m.limit,
    requiresReview: m.requiresReview,
  })),
});

test("운영진이 새 이벤트 생성 후 응모: 본인 이름·학번 사용, 설정 인원과 자동 승인 적용", async (t) => {
  const app = await setup(t),
    admin = await app.login("테스트관리자"),
    ax = await app.login("AX학생"),
    sf = await app.login("SF학생");
  assert.equal(
    (
      await app.request("/admin/missions/save", {
        method: "POST",
        cookie: ax,
        body: {},
      })
    ).status,
    403,
  );
  const e = await event(app, admin, { rewardAmount: 2000 });
  const missionId = e.missions[0].missionId;
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie: ax,
        body: { missionId, accepted: false },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie: ax,
        body: {
          missionId,
          accepted: true,
          name: "다른사람",
          loginId: "sf001",
          note: "참여합니다.",
        },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie: sf,
        body: { missionId, accepted: true },
      })
    ).status,
    409,
  );
  const entry = (
    await app.request("/admin/missions", { cookie: admin })
  ).data.claims.find((c) => c.mission_id === missionId);
  assert.equal(entry.name, "AX학생");
  assert.equal(entry.login_id, "ax001");
  assert.equal(entry.status, "approved");
  assert.equal(entry.reward_amount, 2000);
  assert.match(entry.coupon_code, /^LP-/);
  assert.equal(
    (await app.request("/missions", { cookie: sf })).data.claims.length,
    0,
  );
});
test("조건·인원 수정은 반영되고 이미 접수된 인원 아래로 낮추거나 이전 기록을 바꿀 수 없음", async (t) => {
  const app = await setup(t),
    admin = await app.login("테스트관리자"),
    ax = await app.login("AX학생"),
    sf = await app.login("SF학생");
  let e = await event(app, admin);
  const missionId = e.missions[0].missionId;
  await app.request("/missions/claim", {
    method: "POST",
    cookie: ax,
    body: { missionId, accepted: true },
  });
  let body = editBody(e);
  body.missions[0].capacity = 2;
  body.missions[0].description = "새 참여 조건";
  assert.equal(
    (
      await app.request("/admin/missions/save", {
        method: "POST",
        cookie: admin,
        body,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie: sf,
        body: { missionId, accepted: true },
      })
    ).status,
    201,
  );
  body.missions[0].capacity = 1;
  assert.equal(
    (
      await app.request("/admin/missions/save", {
        method: "POST",
        cookie: admin,
        body,
      })
    ).status,
    409,
  );
  body.missions[0].capacity = 2;
  body.rewardAmount = 3000;
  assert.equal(
    (
      await app.request("/admin/missions/save", {
        method: "POST",
        cookie: admin,
        body,
      })
    ).status,
    409,
  );
  const claims = (await app.request("/admin/missions", { cookie: admin })).data
    .claims;
  assert.match(
    claims.find((c) => c.user_id === 2).condition_snapshot,
    /참여 조건을 확인하세요/,
  );
  assert.match(
    claims.find((c) => c.user_id === 3).condition_snapshot,
    /새 참여 조건/,
  );
  const another = await event(app, admin, { title: "별도 이벤트" });
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie: ax,
        body: { missionId: another.missions[0].missionId, accepted: true },
      })
    ).status,
    201,
  );
});
test("날짜·지급 인원 유효성 검증과 참여 방식 변경·미션 삭제 제한", async (t) => {
  const app = await setup(t),
    admin = await app.login("테스트관리자"),
    ax = await app.login("AX학생");
  const e = await event(app, admin);
  const body = editBody(e);
  for (const patch of [
    { startDay: "2026-02-30" },
    { endDay: "2026-10-01" },
    { rewardAmount: 0 },
    { missions: [] },
  ])
    assert.equal(
      (
        await app.request("/admin/missions/save", {
          method: "POST",
          cookie: admin,
          body: { ...body, ...patch },
        })
      ).status,
      400,
    );
  await app.request("/missions/claim", {
    method: "POST",
    cookie: ax,
    body: { missionId: e.missions[0].missionId, accepted: true },
  });
  body.missions[0].kind = "lunch";
  assert.equal(
    (
      await app.request("/admin/missions/save", {
        method: "POST",
        cookie: admin,
        body,
      })
    ).status,
    409,
  );
  body.missions = [
    {
      kind: "entry",
      title: "다른 미션",
      description: "새 조건",
      capacity: 20,
      requiresReview: true,
    },
  ];
  assert.equal(
    (
      await app.request("/admin/missions/save", {
        method: "POST",
        cookie: admin,
        body,
      })
    ).status,
    409,
  );
});
test("여러 이벤트는 정원·기간·중복 참여 기준이 분리되고 초안은 학생에게 보이지 않음", async (t) => {
  const app = await setup(t),
    admin = await app.login("테스트관리자"),
    ax = await app.login("AX학생");
  const future = await event(app, admin, { startDay: "2026-10-13" });
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie: ax,
        body: { missionId: future.missions[0].missionId, accepted: true },
      })
    ).status,
    409,
  );
  const expired = await event(app, admin, {
    startDay: "2026-10-01",
    endDay: "2026-10-11",
  });
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie: ax,
        body: { missionId: expired.missions[0].missionId, accepted: true },
      })
    ).status,
    409,
  );
  const e = await event(app, admin, { title: "접수 중단 이벤트" });
  await app.request("/admin/missions/event", {
    method: "POST",
    cookie: admin,
    body: { eventId: e.id, active: false },
  });
  assert.equal(
    (await app.request("/missions", { cookie: ax })).data.events.some(
      (x) => x.id === e.id,
    ),
    false,
  );
  assert.equal(
    (
      await app.request("/missions/claim", {
        method: "POST",
        cookie: ax,
        body: { missionId: e.missions[0].missionId, accepted: true },
      })
    ).status,
    409,
  );
});

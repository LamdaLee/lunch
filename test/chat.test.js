import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";

test("채팅은 시간 제한 없이 보낼 수 있고 지난 대화도 남으며 삭제가 다른 화면에도 반영", async (t) => {
  const app = await fixture({ time: "2026-10-12T08:59:00+09:00" });
  t.after(() => app.close());
  const ax = await app.login("AX학생");
  const sf = await app.login("SF학생");
  const admin = await app.login("테스트관리자");
  const send = (cookie, body) =>
    app.request("/chat", { method: "POST", cookie, body: { body } });
  assert.equal((await app.request("/chat")).status, 401);
  assert.equal((await app.request("/chat", { cookie: ax })).data.open, true);

  app.setTime("2026-10-12T09:00:00+09:00");
  assert.equal((await send(ax, "  ")).status, 400);
  assert.equal((await send(ax, "x".repeat(301))).status, 400);
  const first = await send(ax, "오늘 파스타 어때요?");
  assert.equal(first.status, 201);
  assert.equal((await send(ax, "연속")).status, 429);
  assert.equal((await send(sf, "<b>좋아요</b>")).status, 201);
  app.setTime("2026-10-12T09:00:03+09:00");
  const third = await send(ax, "12:50에 1층에서 만나요");

  const all = (await app.request("/chat", { cookie: sf })).data;
  assert.equal(all.open, true);
  assert.deepEqual(
    all.messages.map((m) => [m.name, m.body]),
    [
      ["AX학생", "오늘 파스타 어때요?"],
      ["SF학생", "<b>좋아요</b>"],
      ["AX학생", "12:50에 1층에서 만나요"],
    ],
  );
  assert.equal(JSON.stringify(all).includes("ax001"), false);

  // Incremental polling returns only newer messages plus deletions.
  const cursor = all.messages.at(-1).id;
  assert.equal(
    (await app.request(`/chat?after=${cursor}`, { cookie: sf })).data.messages
      .length,
    0,
  );
  assert.equal(
    (await app.request("/chat?after=abc", { cookie: sf })).status,
    400,
  );
  assert.equal(
    (
      await app.request(`/chat/${first.data.id}`, {
        method: "DELETE",
        cookie: sf,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request(`/chat/${first.data.id}`, {
        method: "DELETE",
        cookie: ax,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request(`/chat/${third.data.id}`, {
        method: "DELETE",
        cookie: admin,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request(`/chat/${third.data.id}`, {
        method: "DELETE",
        cookie: admin,
        body: {},
      })
    ).status,
    404,
  );
  const poll = (await app.request(`/chat?after=${cursor}`, { cookie: sf }))
    .data;
  assert.deepEqual(
    poll.deletedIds.sort(),
    [first.data.id, third.data.id].sort(),
  );
  assert.deepEqual(
    (await app.request("/chat", { cookie: sf })).data.messages.map(
      (m) => m.body,
    ),
    ["<b>좋아요</b>"],
  );
  assert.equal(
    (
      await app.db
        .prepare("SELECT body FROM chat_messages WHERE id=?")
        .get(first.data.id)
    ).body,
    "",
  );

  app.setTime("2026-10-12T12:59:59+09:00");
  assert.equal((await send(sf, "곧 마감")).status, 201);
  app.setTime("2026-10-12T13:00:05+09:00");
  assert.equal((await send(sf, "오후에도 돼요")).status, 201);
  app.setTime("2026-10-12T23:30:00+09:00");
  const night = await app.login("SF학생");
  assert.equal((await send(night, "밤에도 돼요")).status, 201);
  const evening = (await app.request("/chat", { cookie: night })).data;
  assert.equal(evening.open, true);
  assert.equal(evening.messages.length, 4);

  // 다음 날에도 어제 대화가 남아 있고, 새 메시지가 이어서 붙는다.
  app.setTime("2026-10-13T09:30:00+09:00");
  const sf2 = await app.login("SF학생");
  const nextDay = (await app.request("/chat", { cookie: sf2 })).data;
  assert.equal(nextDay.day, "2026-10-13");
  assert.deepEqual(
    nextDay.messages.map((m) => [m.day, m.body]),
    [
      ["2026-10-12", "<b>좋아요</b>"],
      ["2026-10-12", "곧 마감"],
      ["2026-10-12", "오후에도 돼요"],
      ["2026-10-12", "밤에도 돼요"],
    ],
  );
  const today = await send(sf2, "오늘도 좋아요");
  const polled = (
    await app.request(`/chat?after=${nextDay.messages.at(-1).id}`, {
      cookie: sf2,
    })
  ).data;
  assert.deepEqual(
    polled.messages.map((m) => [m.id, m.day]),
    [[today.data.id, "2026-10-13"]],
  );
  // 어제 메시지를 지워도 다른 화면에 반영된다.
  const yesterday = nextDay.messages[0].id;
  const removed = await app.request(`/chat/${yesterday}`, {
    method: "DELETE",
    cookie: await app.login("테스트관리자"),
    body: {},
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(
    (
      await app.request(`/chat?after=${today.data.id}`, { cookie: sf2 })
    ).data.deletedIds.includes(yesterday),
    true,
  );
});

test("채팅은 최근 200개만 처음에 보여 준다", async (t) => {
  const app = await fixture({ time: "2026-10-12T10:00:00+09:00" });
  t.after(() => app.close());
  const ax = await app.login("AX학생");
  const { id } = await app.db
    .prepare("SELECT id FROM users WHERE login_id='ax001'")
    .get();
  const add = app.db.prepare(
    "INSERT INTO chat_messages(user_id,day,body,created_at) VALUES (?,?,?,?)",
  );
  for (let i = 1; i <= 205; i++)
    await add.run(id, "2026-10-11", `m${i}`, "2026-10-11T01:00:00.000Z");
  const list = (await app.request("/chat", { cookie: ax })).data.messages;
  assert.equal(list.length, 200);
  assert.equal(list[0].body, "m6");
  assert.equal(list.at(-1).body, "m205");
});

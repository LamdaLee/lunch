import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";

test("채팅은 09:00–13:00에만 보낼 수 있고 오늘 메시지만 보이며 삭제가 다른 화면에도 반영", async (t) => {
  const app = await fixture({ time: "2026-10-12T08:59:00+09:00" });
  t.after(() => app.close());
  const ax = await app.login("AX학생");
  const sf = await app.login("SF학생");
  const admin = await app.login("테스트관리자");
  const send = (cookie, body) =>
    app.request("/chat", { method: "POST", cookie, body: { body } });
  assert.equal((await app.request("/chat")).status, 401);
  assert.equal((await send(ax, "일찍 왔어요")).status, 409);
  assert.equal((await app.request("/chat", { cookie: ax })).data.open, false);

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
  assert.equal((await app.request("/chat?after=abc", { cookie: sf })).status, 400);
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
  assert.deepEqual(poll.deletedIds.sort(), [first.data.id, third.data.id].sort());
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
  app.setTime("2026-10-12T13:00:00+09:00");
  assert.equal((await send(sf, "늦었다")).status, 409);
  const afternoon = (await app.request("/chat", { cookie: sf })).data;
  assert.equal(afternoon.open, false);
  assert.equal(afternoon.messages.length, 2);

  // The next day starts with an empty room.
  app.setTime("2026-10-13T09:30:00+09:00");
  const nextDay = (
    await app.request("/chat", { cookie: await app.login("SF학생") })
  ).data;
  assert.equal(nextDay.day, "2026-10-13");
  assert.equal(nextDay.messages.length, 0);
});

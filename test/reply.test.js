import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";

test("식당은 12:50까지 요청에 답하고, 학생이 요청을 고치거나 식당을 바꾸면 답변이 지워짐", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const tokenOf = async (id) =>
    (
      await app.db
        .prepare("SELECT access_token FROM restaurants WHERE id=?")
        .get(id)
    ).access_token;
  const mine = await tokenOf(1),
    other = await tokenOf(2);
  const ax = await app.login("AX학생");
  const sf = await app.login("SF학생");
  await app.request("/choice", {
    method: "POST",
    cookie: ax,
    body: { restaurantId: 1 },
  });
  await app.request("/choice", {
    method: "POST",
    cookie: sf,
    body: { restaurantId: 1 },
  });
  const setRequest = (cookie, request) =>
    app.request("/choice/request", {
      method: "POST",
      cookie,
      body: { request },
    });
  await setRequest(ax, "계란 빼주세요");
  const page = async () =>
    (await app.request("/restaurant?token=" + mine)).data;
  let data = await page();
  assert.equal(data.replyOpen, true);
  const order = data.orders.find((o) => o.name === "AX학생");
  const sfReservation = (
    await app.db
      .prepare(
        "SELECT r.id FROM reservations r JOIN users u ON u.id=r.user_id WHERE u.login_id='sf001'",
      )
      .get()
  ).id;
  const reply = (token, reservationId, value) =>
    app.request("/restaurant/reply", {
      method: "POST",
      body: { token, reservationId, reply: value },
    });
  assert.equal((await reply("wrong", order.id, "확인했어요")).status, 404);
  assert.equal((await reply(other, order.id, "확인했어요")).status, 404);
  // No request to answer.
  assert.equal((await reply(mine, sfReservation, "확인했어요")).status, 404);
  assert.equal((await reply(mine, order.id, "x".repeat(101))).status, 400);
  assert.equal((await reply(mine, String(order.id), "확인")).status, 400);
  assert.equal(
    (await reply(mine, order.id, " 계란 빼 드릴게요 ")).status,
    200,
  );
  data = await page();
  assert.equal(
    data.orders.find((o) => o.id === order.id).reply,
    "계란 빼 드릴게요",
  );
  const dashboard = (await app.request("/dashboard", { cookie: ax })).data;
  assert.equal(dashboard.reservation.reply, "계란 빼 드릴게요");
  assert.ok(dashboard.reservation.reply_at);
  // Other students never see someone else's reply.
  assert.equal(
    JSON.stringify((await app.request("/dashboard", { cookie: sf })).data)
      .includes("계란 빼 드릴게요"),
    false,
  );

  // Saving the same request keeps the reply; a changed request drops it.
  await setRequest(ax, "계란 빼주세요");
  assert.equal(
    (await app.request("/dashboard", { cookie: ax })).data.reservation.reply,
    "계란 빼 드릴게요",
  );
  await setRequest(ax, "계란 빼고 밥 적게 주세요");
  let mineNow = (await app.request("/dashboard", { cookie: ax })).data
    .reservation;
  assert.equal(mineNow.reply, "");
  assert.equal(mineNow.reply_at, null);
  assert.equal((await reply(mine, order.id, "어려워요")).status, 200);
  // A menu change at the same restaurant keeps it.
  await app.request("/choice", {
    method: "POST",
    cookie: ax,
    body: { restaurantId: 1, menuNote: "제육덮밥" },
  });
  assert.equal(
    (await app.request("/dashboard", { cookie: ax })).data.reservation.reply,
    "어려워요",
  );
  // Restaurants may answer after the noon cutoff, until 12:50.
  app.setTime("2026-10-12T12:45:00+09:00");
  assert.equal((await reply(mine, order.id, "확인했어요")).status, 200);
  app.setTime("2026-10-12T12:50:00+09:00");
  assert.equal((await page()).replyOpen, false);
  assert.equal((await reply(mine, order.id, "늦은 답변")).status, 409);
  app.setTime("2026-10-12T11:00:00+09:00");
  // Moving to another restaurant clears the request and its reply.
  await app.request("/choice", {
    method: "POST",
    cookie: ax,
    body: { restaurantId: 2 },
  });
  mineNow = (await app.request("/dashboard", { cookie: ax })).data.reservation;
  assert.equal(mineNow.request, "");
  assert.equal(mineNow.reply, "");
});

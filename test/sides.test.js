import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";

test("메인 하나와 사이드 여러 개를 함께 예약하고 식당은 사이드까지 확인", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const tokenOf = async (id) =>
    (
      await app.db
        .prepare("SELECT access_token FROM restaurants WHERE id=?")
        .get(id)
    ).access_token;
  const token = await tokenOf(1),
    other = await tokenOf(2);
  const add = (body, t2 = token) =>
    app.request("/restaurant/menu", {
      method: "POST",
      body: { token: t2, ...body },
    });
  assert.equal((await add({ name: "제육덮밥", price: 9000 })).status, 201);
  assert.equal(
    (await add({ name: "계란찜", price: 2000, kind: "side" })).status,
    201,
  );
  assert.equal(
    (await add({ name: "콜라", price: 1500, kind: "side" })).status,
    201,
  );
  assert.equal(
    (await add({ name: "잘못", price: 0, kind: "dessert" })).status,
    400,
  );
  await add({ name: "만두", price: 3000, kind: "side" }, other);
  let page = (await app.request("/restaurant?token=" + token)).data;
  assert.deepEqual(
    page.menuItems.map((m) => [m.name, m.kind]),
    [
      ["제육덮밥", "main"],
      ["계란찜", "side"],
      ["콜라", "side"],
    ],
  );
  const [jeyuk, egg, cola] = page.menuItems;
  const dumpling = (await app.request("/restaurant?token=" + other)).data
    .menuItems[0];

  const ax = await app.login("AX학생");
  const sf = await app.login("SF학생");
  const choose = (cookie, body) =>
    app.request("/choice", {
      method: "POST",
      cookie,
      body: { restaurantId: 1, ...body },
    });
  // A side is not a main, and sides must belong to this restaurant.
  assert.equal((await choose(ax, { menuItemId: egg.id })).status, 404);
  assert.equal(
    (await choose(ax, { menuItemId: jeyuk.id, sideIds: [dumpling.id] }))
      .status,
    404,
  );
  assert.equal(
    (await choose(ax, { menuItemId: jeyuk.id, sideIds: [egg.id, egg.id] }))
      .status,
    400,
  );
  assert.equal(
    (await choose(ax, { menuItemId: jeyuk.id, sideIds: "1" })).status,
    400,
  );
  // Sides alone do not satisfy a restaurant that has main menus.
  assert.equal((await choose(ax, { sideIds: [egg.id] })).status, 400);
  assert.equal(
    (await choose(ax, { menuItemId: jeyuk.id, sideIds: [egg.id, cola.id] }))
      .status,
    200,
  );
  assert.equal(
    (await choose(ax, { menuItemId: jeyuk.id, sideIds: [cola.id, egg.id] }))
      .status,
    409,
  );
  assert.equal(
    (await choose(sf, { menuNote: "제육 곱빼기", sideIds: [egg.id] })).status,
    200,
  );
  const mine = (await app.request("/dashboard", { cookie: ax })).data
    .reservation;
  assert.deepEqual(
    mine.sides.map((s) => [s.name, s.price]),
    [
      ["계란찜", 2000],
      ["콜라", 1500],
    ],
  );
  const card = (await app.request("/dashboard", { cookie: ax })).data
    .restaurants[0];
  assert.deepEqual(
    card.menuItems.map((m) => m.kind),
    ["main", "side", "side"],
  );

  page = (await app.request("/restaurant?token=" + token)).data;
  const byName = Object.fromEntries(page.orders.map((o) => [o.name, o]));
  assert.deepEqual(
    byName["AX학생"].sides.map((s) => s.name),
    ["계란찜", "콜라"],
  );
  assert.deepEqual(
    byName["SF학생"].sides.map((s) => s.name),
    ["계란찜"],
  );
  const admin = await app.login("테스트관리자");
  const overview = (await app.request("/admin/overview", { cookie: admin }))
    .data.reservations;
  assert.equal(
    overview.find((r) => r.name === "AX학생").sides,
    "계란찜, 콜라",
  );

  // Changing only the sides is allowed; dropping them clears the rows.
  assert.equal(
    (await choose(ax, { menuItemId: jeyuk.id, sideIds: [cola.id] })).status,
    200,
  );
  assert.equal(
    (await choose(ax, { menuItemId: jeyuk.id })).status,
    200,
  );
  assert.equal(
    (await app.request("/dashboard", { cookie: ax })).data.reservation.sides
      .length,
    0,
  );
  // An existing side can become a main via edit; cancelling removes sides.
  assert.equal(
    (await add({ id: cola.id, name: "콜라", price: 1500, kind: "main" }))
      .status,
    200,
  );
  assert.equal(
    (
      await app.request("/choice", { method: "DELETE", cookie: sf, body: {} })
    ).status,
    200,
  );
  assert.equal(
    (await app.db.prepare("SELECT COUNT(*) n FROM reservation_sides").get()).n,
    0,
  );
  // Switching restaurants drops sides of the old restaurant.
  await choose(sf, { menuItemId: jeyuk.id, sideIds: [egg.id] });
  await app.request("/choice", {
    method: "POST",
    cookie: sf,
    body: { restaurantId: 3 },
  });
  assert.equal(
    (await app.db.prepare("SELECT COUNT(*) n FROM reservation_sides").get()).n,
    0,
  );
});

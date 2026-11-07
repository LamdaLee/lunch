import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";

test("식당과 운영진이 하루 최대 인원을 정하면 정원이 찬 뒤 새 선택만 막음", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const token = (
    await app.db
      .prepare("SELECT access_token FROM restaurants WHERE id=1")
      .get()
  ).access_token;
  const setLimit = (maxPeople, value = token) =>
    app.request("/restaurant/limit", {
      method: "POST",
      body: { token: value, maxPeople },
    });
  assert.equal((await setLimit(2, "wrong")).status, 404);
  assert.equal((await setLimit(-1)).status, 400);
  assert.equal((await setLimit(501)).status, 400);
  assert.equal((await setLimit(1.5)).status, 400);
  assert.equal((await setLimit(2)).status, 200);
  assert.equal(
    (await app.request("/restaurant?token=" + token)).data.restaurant
      .max_people,
    2,
  );

  const ax = await app.login("AX학생");
  const sf = await app.login("SF학생");
  const staff = await app.login("테스트강사");
  const choose = (cookie, restaurantId, extra = {}) =>
    app.request("/choice", {
      method: "POST",
      cookie,
      body: { restaurantId, ...extra },
    });
  assert.equal((await choose(ax, 1)).status, 200);
  assert.equal((await choose(sf, 1)).status, 200);
  const full = await choose(staff, 1);
  assert.equal(full.status, 409);
  assert.match(full.data.error, /정원 2명/);
  const card = (await app.request("/dashboard", { cookie: staff })).data
    .restaurants[0];
  assert.equal(card.max_people, 2);
  assert.equal(card.count, 2);
  // People already in can still change their menu at the same restaurant.
  assert.equal(
    (await choose(ax, 1, { menuNote: "제육덮밥" })).status,
    200,
  );
  // Leaving frees a seat.
  assert.equal(
    (await app.request("/choice", { method: "DELETE", cookie: sf, body: {} }))
      .status,
    200,
  );
  assert.equal((await choose(staff, 1)).status, 200);

  // Admin lowers the limit below the current count: existing picks stay.
  const admin = await app.login("테스트관리자");
  const save = (body) =>
    app.request("/admin/restaurants", {
      method: "POST",
      cookie: admin,
      body: {
        id: 1,
        name: "한끼식당",
        description: "",
        menu: "",
        listed: true,
        ...body,
      },
    });
  assert.equal((await save({ maxPeople: -3 })).status, 400);
  assert.equal((await save({ maxPeople: 1 })).status, 200);
  const overview = (await app.request("/admin/overview", { cookie: admin }))
    .data;
  assert.equal(overview.restaurants.find((r) => r.id === 1).max_people, 1);
  assert.equal(overview.reservations.length, 2);
  assert.equal((await choose(sf, 1)).status, 409);
  // Saving without the field keeps the limit; 0 removes it.
  assert.equal((await save({})).status, 200);
  assert.equal(
    (await app.db.prepare("SELECT max_people FROM restaurants WHERE id=1").get())
      .max_people,
    1,
  );
  assert.equal((await save({ maxPeople: 0 })).status, 200);
  assert.equal((await choose(sf, 1)).status, 200);
  // Other restaurants stay unlimited, and the legacy capacity column is ignored.
  assert.equal(
    (await app.db.prepare("SELECT capacity FROM restaurants WHERE id=2").get())
      .capacity,
    1,
  );
  assert.equal((await choose(admin, 2)).status, 200);
});

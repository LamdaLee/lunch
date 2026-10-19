import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";

test("같은 식당을 고른 사람끼리 일행으로 묶고 식당은 일행별로 확인", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const token = (
    await app.db
      .prepare("SELECT access_token FROM restaurants WHERE id=1")
      .get()
  ).access_token;
  const ax = await app.login("AX학생");
  const sf = await app.login("SF학생");
  const staff = await app.login("테스트강사");
  const admin = await app.login("테스트관리자");
  const id = async (loginId) =>
    (await app.db.prepare("SELECT id FROM users WHERE login_id=?").get(loginId))
      .id;
  const [axId, sfId, staffId, adminId] = await Promise.all(
    ["ax001", "sf001", "staff001", "admin"].map(id),
  );
  const choose = (cookie, restaurantId) =>
    app.request("/choice", { method: "POST", cookie, body: { restaurantId } });
  const party = (cookie, memberIds) =>
    app.request("/party", { method: "POST", cookie, body: { memberIds } });
  const orders = async () =>
    (await app.request("/restaurant?token=" + token)).data;

  assert.equal((await party(ax, [sfId])).status, 404);
  for (const cookie of [ax, sf, staff]) await choose(cookie, 1);
  await choose(admin, 2);
  assert.equal((await party(ax, [])).status, 400);
  assert.equal((await party(ax, ["x"])).status, 400);
  assert.equal((await party(ax, [axId])).status, 400);
  // Someone at another restaurant cannot be pulled in.
  assert.equal((await party(ax, [adminId])).status, 409);

  const dashboard = (await app.request("/dashboard", { cookie: ax })).data;
  assert.deepEqual(
    dashboard.companions.map((c) => [c.name, c.inMyParty]).sort(),
    [
      ["SF학생", false],
      ["테스트강사", false],
    ],
  );
  assert.equal(
    (await app.request("/dashboard", { cookie: admin })).data.companions.length,
    0,
  );

  assert.equal((await party(ax, [sfId])).status, 200);
  let page = await orders();
  assert.equal(page.count, 3);
  const grouped = page.orders.filter((o) => o.party !== null);
  assert.deepEqual(grouped.map((o) => o.name).sort(), ["AX학생", "SF학생"]);
  assert.equal(new Set(grouped.map((o) => o.party)).size, 1);
  assert.equal(
    page.orders.some((o) => o.name === "테스트강사"),
    false,
    "solo guests without menu or request are only counted",
  );
  // Both sides see the party.
  assert.deepEqual(
    (await app.request("/dashboard", { cookie: sf })).data.companions
      .filter((c) => c.inMyParty)
      .map((c) => c.name),
    ["AX학생"],
  );

  // Joining one member of a party joins the whole party.
  assert.equal((await party(staff, [sfId])).status, 200);
  page = await orders();
  assert.equal(new Set(page.orders.map((o) => o.party)).size, 1);
  assert.equal(page.orders.length, 3);

  // Leaving, switching restaurants and cancelling all shrink the party.
  assert.equal(
    (await app.request("/party/leave", { method: "POST", cookie: staff, body: {} }))
      .status,
    200,
  );
  assert.equal(
    (await app.request("/party/leave", { method: "POST", cookie: staff, body: {} }))
      .status,
    404,
  );
  page = await orders();
  assert.equal(page.orders.filter((o) => o.party !== null).length, 2);
  await choose(sf, 2);
  // AX is now alone, so the party dissolves instead of showing a party of one.
  page = await orders();
  assert.equal(page.orders.length, 0);
  assert.equal(
    (await app.db.prepare("SELECT COUNT(*) n FROM reservations WHERE party_id IS NOT NULL").get()).n,
    0,
  );
  await choose(sf, 1);
  assert.equal((await party(sf, [axId, staffId])).status, 200);
  assert.equal(
    (await app.request("/choice", { method: "DELETE", cookie: staff, body: {} }))
      .status,
    200,
  );
  page = await orders();
  assert.deepEqual(
    page.orders.map((o) => o.name).sort(),
    ["AX학생", "SF학생"],
  );
  app.setTime("2026-10-12T12:40:00+09:00");
  assert.equal((await party(ax, [sfId])).status, 409);
  assert.equal(
    (await app.request("/party/leave", { method: "POST", cookie: ax, body: {} }))
      .status,
    409,
  );
});

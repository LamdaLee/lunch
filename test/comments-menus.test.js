import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";

test("게시글 댓글은 로그인한 이용자가 달고 작성자와 운영진만 삭제", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const ax = await app.login("AX학생");
  const sf = await app.login("SF학생");
  const admin = await app.login("테스트관리자");
  await app.request("/posts", {
    method: "POST",
    cookie: ax,
    body: { title: "칼국수 가실 분", body: "같이 가요" },
  });
  const postId = (await app.request("/posts", { cookie: ax })).data.posts[0]
    .id;
  const comment = (cookie, body) =>
    app.request(`/posts/${postId}/comments`, {
      method: "POST",
      cookie,
      body: { body },
    });
  assert.equal(
    (
      await app.request(`/posts/${postId}/comments`, {
        method: "POST",
        body: { body: "익명" },
      })
    ).status,
    401,
  );
  assert.equal((await comment(sf, "  ")).status, 400);
  assert.equal((await comment(sf, "x".repeat(501))).status, 400);
  assert.equal((await comment(sf, "저도 갈래요")).status, 201);
  assert.equal((await comment(sf, "연속 댓글")).status, 429);
  app.setTime("2026-10-12T10:00:06+09:00");
  assert.equal((await comment(ax, "좋아요")).status, 201);
  assert.equal(
    (
      await app.request("/posts/9999/comments", {
        method: "POST",
        cookie: ax,
        body: { body: "없는 글" },
      })
    ).status,
    404,
  );

  const board = (await app.request("/posts", { cookie: ax })).data.posts[0];
  assert.deepEqual(
    board.comments.map((c) => [c.name, c.body]),
    [
      ["SF학생", "저도 갈래요"],
      ["AX학생", "좋아요"],
    ],
  );
  assert.equal(JSON.stringify(board.comments).includes("sf001"), false);
  const detail = (await app.request(`/posts/${postId}`, { cookie: ax })).data
    .post;
  assert.equal(detail.comments.length, 2);

  const [sfComment, axComment] = board.comments;
  assert.equal(
    (
      await app.request(`/comments/${sfComment.id}`, {
        method: "DELETE",
        cookie: ax,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request(`/comments/${sfComment.id}`, {
        method: "DELETE",
        cookie: sf,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request(`/comments/${axComment.id}`, {
        method: "DELETE",
        cookie: admin,
        body: {},
      })
    ).status,
    200,
  );
  app.setTime("2026-10-12T10:00:12+09:00");
  assert.equal((await comment(sf, "다시 남김")).status, 201);
  // Deleting a post removes its comments as well.
  assert.equal(
    (
      await app.request(`/posts/${postId}`, {
        method: "DELETE",
        cookie: ax,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await app.db.prepare("SELECT COUNT(*) n FROM post_comments").get()).n,
    0,
  );
});

test("식당이 링크로 메뉴를 등록하고 누가 어떤 메뉴를 예약했는지 확인", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const restaurantToken = (
    await app.db
      .prepare("SELECT access_token FROM restaurants WHERE id=1")
      .get()
  ).access_token;
  const otherToken = (
    await app.db
      .prepare("SELECT access_token FROM restaurants WHERE id=2")
      .get()
  ).access_token;
  const addMenu = (token, name, price) =>
    app.request("/restaurant/menu", {
      method: "POST",
      body: { token, name, price },
    });
  assert.equal((await addMenu("wrong", "제육덮밥", 9000)).status, 404);
  assert.equal((await addMenu(restaurantToken, "", 9000)).status, 400);
  assert.equal((await addMenu(restaurantToken, "제육덮밥", -1)).status, 400);
  assert.equal((await addMenu(restaurantToken, "제육덮밥", 9000)).status, 201);
  assert.equal((await addMenu(restaurantToken, "김치찌개", 8000)).status, 201);
  assert.equal((await addMenu(otherToken, "잔치국수", 7000)).status, 201);
  let page = (await app.request("/restaurant?token=" + restaurantToken)).data;
  assert.deepEqual(
    page.menuItems.map((m) => [m.name, m.price]),
    [
      ["제육덮밥", 9000],
      ["김치찌개", 8000],
    ],
  );
  const [jeyuk, kimchi] = page.menuItems;
  const noodle = (await app.request("/restaurant?token=" + otherToken)).data
    .menuItems[0];
  // A restaurant cannot change another restaurant's menu.
  assert.equal(
    (
      await app.request("/restaurant/menu/remove", {
        method: "POST",
        body: { token: restaurantToken, id: noodle.id },
      })
    ).status,
    404,
  );

  const ax = await app.login("AX학생");
  const sf = await app.login("SF학생");
  const choose = (cookie, body) =>
    app.request("/choice", { method: "POST", cookie, body });
  const dashboard = (await app.request("/dashboard", { cookie: ax })).data;
  assert.deepEqual(
    dashboard.restaurants[0].menuItems.map((m) => m.name),
    ["제육덮밥", "김치찌개"],
  );
  assert.equal((await choose(ax, { restaurantId: 1 })).status, 400);
  assert.equal(
    (await choose(ax, { restaurantId: 1, menuItemId: noodle.id })).status,
    404,
  );
  assert.equal(
    (await choose(ax, { restaurantId: 1, menuItemId: jeyuk.id })).status,
    200,
  );
  assert.equal(
    (await choose(ax, { restaurantId: 1, menuItemId: jeyuk.id })).status,
    409,
  );
  assert.equal(
    (await choose(ax, { restaurantId: 1, menuItemId: kimchi.id })).status,
    200,
  );
  assert.equal(
    (await choose(sf, { restaurantId: 1, menuItemId: jeyuk.id })).status,
    200,
  );
  // Restaurants without menus still accept a plain visit plan.
  const staff = await app.login("테스트강사");
  assert.equal((await choose(staff, { restaurantId: 3 })).status, 200);

  const mine = (await app.request("/dashboard", { cookie: ax })).data
    .reservation;
  assert.equal(mine.menu, "김치찌개");
  assert.equal(mine.menu_price, 8000);

  page = (await app.request("/restaurant?token=" + restaurantToken)).data;
  assert.equal(page.count, 2);
  assert.deepEqual(
    page.orders.map((o) => [o.menu, o.name, o.track]),
    [
      ["제육덮밥", "SF학생", "SF"],
      ["김치찌개", "AX학생", "AX"],
    ],
  );
  assert.equal(JSON.stringify(page).includes("ax001"), false);
  assert.equal(JSON.stringify(page).includes("테스트강사"), false);

  // Removing a menu keeps existing reservations but blocks new ones.
  assert.equal(
    (
      await app.request("/restaurant/menu/remove", {
        method: "POST",
        body: { token: restaurantToken, id: jeyuk.id },
      })
    ).status,
    200,
  );
  page = (await app.request("/restaurant?token=" + restaurantToken)).data;
  assert.deepEqual(
    page.menuItems.map((m) => m.name),
    ["김치찌개"],
  );
  assert.equal(page.orders.length, 2);
  assert.equal(
    (await choose(ax, { restaurantId: 1, menuItemId: jeyuk.id })).status,
    404,
  );

  const admin = await app.login("테스트관리자");
  const overview = (await app.request("/admin/overview", { cookie: admin }))
    .data;
  assert.deepEqual(
    overview.reservations
      .filter((r) => r.restaurant === "한끼식당")
      .map((r) => [r.name, r.menu])
      .sort(),
    [
      ["AX학생", "김치찌개"],
      ["SF학생", "제육덮밥"],
    ],
  );

  // Menu reservations close with the regular noon deadline.
  app.setTime("2026-10-12T12:00:00+09:00");
  assert.equal(
    (await choose(sf, { restaurantId: 1, menuItemId: kimchi.id })).status,
    409,
  );
  app.setTime("2026-10-13T10:00:00+09:00");
  page = (await app.request("/restaurant?token=" + restaurantToken)).data;
  assert.equal(page.orders.length, 0);
});

export async function notificationSummary(db, user) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) n,MAX(id) latest FROM notifications WHERE user_id=? AND (target_tab<>'admin' OR ?='admin') AND read_at IS NULL",
    )
    .get(user.id, user.role);
  const last = await db
    .prepare(
      "SELECT MAX(id) latest FROM notifications WHERE user_id=? AND (target_tab<>'admin' OR ?='admin')",
    )
    .get(user.id, user.role);
  return { unread: row.n, latestId: last.latest || 0 };
}
export async function listNotifications(db, user, before, fail) {
  if (
    before !== null &&
    (!/^\d+$/.test(before) ||
      Number(before) < 1 ||
      !Number.isSafeInteger(Number(before)))
  )
    fail(400, "알림 조회 기준을 확인해주세요.");
  const rows = await db
    .prepare(
      `SELECT id,title,body,target_tab,event_id,created_at,read_at FROM notifications WHERE user_id=? AND (target_tab<>'admin' OR ?='admin') ${before !== null ? "AND id<?" : ""} ORDER BY id DESC LIMIT 51`,
    )
    .all(user.id, user.role, ...(before !== null ? [Number(before)] : []));
  const notifications = rows.slice(0, 50);
  return {
    ...(await notificationSummary(db, user)),
    notifications,
    nextBefore: rows.length > 50 ? notifications.at(-1).id : null,
  };
}
export async function readNotification(db, user, body, now, fail) {
  if (body.all === true) {
    await db
      .prepare(
        "UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL AND (target_tab<>'admin' OR ?='admin')",
      )
      .run(now.toISOString(), user.id, user.role);
    return { ok: true };
  }
  if (!Number.isInteger(body.id)) fail(400, "알림을 선택해주세요.");
  const notification = await db
    .prepare(
      "SELECT id,target_tab,event_id FROM notifications WHERE id=? AND user_id=? AND (target_tab<>'admin' OR ?='admin')",
    )
    .get(body.id, user.id, user.role);
  if (!notification) fail(404, "알림을 찾을 수 없습니다.");
  await db
    .prepare("UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?")
    .run(now.toISOString(), notification.id);
  return {
    ok: true,
    targetTab: notification.target_tab,
    eventId: notification.event_id,
  };
}

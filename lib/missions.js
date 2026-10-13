import { token } from "./store.js";

export async function missionSummary(db) {
  const events = await db
    .prepare("SELECT * FROM mission_event ORDER BY id DESC")
    .all();
  const missions = await db
    .prepare(
      "SELECT m.*,COUNT(c.id) count FROM event_missions m LEFT JOIN mission_claims c ON c.mission_id=m.id AND c.status<>? GROUP BY m.id ORDER BY m.id",
    )
    .all("rejected");
  return {
    events: events.map((event) => ({
      ...event,
      missions: missions
        .filter((m) => m.event_id === event.id)
        .map((m) => ({
          id: m.kind,
          missionId: m.id,
          kind: m.kind,
          title: m.title,
          description: m.description,
          limit: m.capacity,
          requiresReview: Boolean(m.requires_review),
          used: m.count,
        })),
    })),
  };
}
export async function memberMissions(db, user, clock) {
  const summary = await missionSummary(db);
  const claims = await db
    .prepare(
      "SELECT id,event_id,mission_id,mission,status,post_id,reward_amount,coupon_code,review_note,created_at FROM mission_claims WHERE user_id=?",
    )
    .all(user.id);
  const events = summary.events.filter(
    (e) => e.active || claims.some((c) => c.event_id === e.id),
  );
  const earliest = events.reduce(
    (day, e) => (e.start_day < day ? e.start_day : day),
    clock.day,
  );
  const posts = await db
    .prepare(
      "SELECT id,title,body,created_at FROM posts WHERE user_id=? AND created_at>=? ORDER BY id DESC LIMIT 100",
    )
    .all(user.id, new Date(`${earliest}T00:00:00+09:00`).toISOString());
  const choices = await db
    .prepare(
      "SELECT b.day,COALESCE(a.name,r.name) restaurant FROM reservations b JOIN restaurants r ON r.id=b.restaurant_id LEFT JOIN meal_records m ON m.user_id=b.user_id AND m.day=b.day LEFT JOIN restaurants a ON a.id=m.restaurant_id WHERE b.user_id=? AND b.day>=? AND b.day<=? ORDER BY b.day DESC LIMIT 100",
    )
    .all(user.id, earliest, clock.day);
  return {
    events,
    event: events.find((e) => e.id === 1) || events[0],
    claims,
    posts,
    choices,
    eligible: user.role === "member" && user.track !== "OTHER",
    user: { name: user.name, loginId: user.login_id },
    day: clock.day,
    minute: clock.minute,
  };
}
export async function claimMission(db, user, clock, body, now, fail) {
  if (user.role !== "member" || user.track === "OTHER")
    fail(403, "학생 계정만 쿠폰 이벤트에 참여할 수 있습니다.");
  const mission = Number.isInteger(body.missionId)
    ? await db
        .prepare("SELECT * FROM event_missions WHERE id=?")
        .get(body.missionId)
    : await db
        .prepare(
          "SELECT * FROM event_missions WHERE event_id=1 AND kind=? ORDER BY id LIMIT 1",
        )
        .get(typeof body.mission === "string" ? body.mission : "");
  if (!mission) fail(400, "이벤트 미션을 선택해주세요.");
  const event = await db
    .prepare("SELECT * FROM mission_event WHERE id=?")
    .get(mission.event_id);
  if (
    !event.active ||
    clock.day < event.start_day ||
    (event.end_day && clock.day > event.end_day)
  )
    fail(409, "현재 이 이벤트의 접수 기간이 아닙니다.");
  const previous = await db
    .prepare(
      "SELECT id,status FROM mission_claims WHERE user_id=? AND mission_id=?",
    )
    .get(user.id, mission.id);
  if (previous && previous.status !== "rejected")
    fail(
      409,
      "이미 참여한 미션입니다. 미션별 한 번만 쿠폰을 받을 수 있습니다.",
    );
  const { n } = await db
    .prepare(
      "SELECT COUNT(*) n FROM mission_claims WHERE mission_id=? AND status<>'rejected'",
    )
    .get(mission.id);
  if (n >= mission.capacity)
    fail(409, `이 미션은 선착순 ${mission.capacity}명 접수가 마감되었습니다.`);
  let postId = null,
    evidence;
  if (mission.kind === "lunch") {
    if (
      body.confirmedMeal !== true ||
      typeof body.day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.day)
    )
      fail(400, "식사한 날짜를 선택하고 식사 완료를 확인해주세요.");
    if (body.day === clock.day && clock.minute < 840)
      fail(
        409,
        "오늘 점심 미션은 식사 시간이 끝나는 오후 2시부터 제출할 수 있습니다.",
      );
    const choice = await db
      .prepare(
        "SELECT b.day,COALESCE(a.name,r.name) restaurant FROM reservations b JOIN restaurants r ON r.id=b.restaurant_id LEFT JOIN meal_records m ON m.user_id=b.user_id AND m.day=b.day LEFT JOIN restaurants a ON a.id=m.restaurant_id WHERE b.user_id=? AND b.day=? AND b.day>=? AND b.day<=?",
      )
      .get(
        user.id,
        body.day,
        event.start_day,
        event.end_day && event.end_day < clock.day ? event.end_day : clock.day,
      );
    if (!choice) fail(400, "이벤트 기간에 선택한 식당 기록이 있어야 합니다.");
    evidence = `${choice.day} · ${choice.restaurant}에서 식사 완료를 확인했습니다.`;
  } else if (mission.kind === "entry") {
    if (body.accepted !== true)
      fail(400, "이벤트 조건을 확인하고 참여 동의에 체크해주세요.");
    if (
      body.note !== undefined &&
      (typeof body.note !== "string" || body.note.length > 500)
    )
      fail(400, "참여 내용은 500자 이내로 입력해주세요.");
    evidence = body.note?.trim() || "이벤트 조건을 확인하고 응모했습니다.";
  } else {
    if (!Number.isInteger(body.postId))
      fail(400, "미션에 사용할 본인 게시글을 선택해주세요.");
    const post = await db
      .prepare("SELECT * FROM posts WHERE id=?")
      .get(body.postId);
    if (!post || post.user_id !== user.id)
      fail(403, "본인이 작성한 게시글만 제출할 수 있습니다.");
    const start = new Date(`${event.start_day}T00:00:00+09:00`).toISOString();
    const end = event.end_day
      ? new Date(
          new Date(`${event.end_day}T00:00:00+09:00`).getTime() + 86400000,
        ).toISOString()
      : null;
    if (post.created_at < start || (end && post.created_at >= end))
      fail(400, "이벤트 기간에 작성한 게시글로 참여해주세요.");
    if (
      await db
        .prepare(
          "SELECT id FROM mission_claims WHERE user_id=? AND event_id=? AND post_id=? AND mission_id<>? AND status<>'rejected'",
        )
        .get(user.id, event.id, post.id, mission.id)
    )
      fail(409, "이 이벤트의 각 미션은 서로 다른 게시글로 참여해주세요.");
    postId = post.id;
    evidence = `${post.title || post.body.split(/\r?\n/)[0].slice(0, 80)}\n\n${post.body}`;
  }
  const status = mission.requires_review ? "pending" : "approved";
  const code =
    status === "approved" ? `LP-${token().slice(0, 10).toUpperCase()}` : null;
  await db
    .prepare(
      `INSERT INTO mission_claims(event_id,mission_id,user_id,mission,entry_name,entry_login_id,reward_amount,condition_snapshot,status,post_id,evidence,created_at,coupon_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,mission_id) DO UPDATE SET status=excluded.status,post_id=excluded.post_id,evidence=excluded.evidence,created_at=excluded.created_at,review_note='',reviewed_by=NULL,reviewed_at=NULL,coupon_code=excluded.coupon_code,condition_snapshot=excluded.condition_snapshot`,
    )
    .run(
      event.id,
      mission.id,
      user.id,
      mission.kind,
      user.name,
      user.login_id,
      event.reward_amount,
      `${mission.title}\n${mission.description}`,
      status,
      postId,
      evidence,
      now.toISOString(),
      code,
    );
  await db
    .prepare(
      "INSERT INTO notifications(user_id,title,body,target_tab,event_id,created_at) SELECT id,?,?,'admin',?,? FROM users WHERE role='admin' AND active=1",
    )
    .run(
      "새 이벤트 응모",
      `${user.name} (${user.login_id}) 님이 '${event.title} · ${mission.title}'에 응모했습니다.${status === "approved" ? " 접수 즉시 승인된 신청입니다." : " 제출 내용을 확인해주세요."}`,
      event.id,
      now.toISOString(),
    );
  if (status === "approved")
    await db
      .prepare(
        "INSERT INTO notifications(user_id,title,body,target_tab,event_id,created_at) VALUES (?,?,?,'missions',?,?)",
      )
      .run(
        user.id,
        "쿠폰 수령 가능",
        `'${event.title} · ${mission.title}' 응모가 승인됐습니다. 이벤트 화면에서 확인번호를 확인하고 운영진에게 쿠폰을 받으세요.`,
        event.id,
        now.toISOString(),
      );
  return { ok: true };
}
export async function adminMissions(db) {
  const { events } = await missionSummary(db);
  const claims = await db
    .prepare(
      "SELECT c.*,u.track FROM mission_claims c JOIN users u ON u.id=c.user_id ORDER BY c.created_at,c.id",
    )
    .all();
  return {
    events,
    event: events.find((e) => e.id === 1) || events[0],
    claims: claims.map((c) => ({
      ...c,
      name: c.entry_name,
      login_id: c.entry_login_id,
    })),
  };
}
export async function reviewMission(db, user, body, now, fail) {
  if (
    !Number.isInteger(body.id) ||
    !["approved", "rejected", "issued"].includes(body.status)
  )
    fail(400, "신청과 처리 상태를 확인해주세요.");
  const claim = await db
    .prepare("SELECT * FROM mission_claims WHERE id=?")
    .get(body.id);
  if (!claim) fail(404, "미션 신청을 찾을 수 없습니다.");
  if (claim.status === body.status) return { ok: true };
  if (
    body.status === "issued"
      ? claim.status !== "approved"
      : claim.status !== "pending"
  )
    fail(409, "신청 상태가 변경되었습니다. 새로고침 후 확인해주세요.");
  let note = "";
  if (body.status === "rejected") {
    if (
      typeof body.note !== "string" ||
      !body.note.trim() ||
      body.note.trim().length > 200
    )
      fail(400, "보완 사유를 200자 이내로 입력해주세요.");
    note = body.note.trim();
  }
  const code =
    body.status === "approved"
      ? `LP-${token().slice(0, 10).toUpperCase()}`
      : claim.coupon_code;
  await db
    .prepare(
      "UPDATE mission_claims SET status=?,review_note=?,reviewed_by=?,reviewed_at=?,coupon_code=? WHERE id=?",
    )
    .run(body.status, note, user.id, now.toISOString(), code, claim.id);
  const event = await db
    .prepare("SELECT title FROM mission_event WHERE id=?")
    .get(claim.event_id);
  const mission = await db
    .prepare("SELECT title FROM event_missions WHERE id=?")
    .get(claim.mission_id);
  const title =
    body.status === "rejected"
      ? "이벤트 보완 요청"
      : body.status === "approved"
        ? "쿠폰 수령 가능"
        : "쿠폰 지급 완료";
  const message =
    body.status === "rejected"
      ? `보완 사유: ${note}
이벤트 화면에서 내용을 보완한 후 다시 응모할 수 있습니다.`
      : body.status === "approved"
        ? "응모가 승인됐습니다. 이벤트 화면에서 확인번호를 확인하고 운영진에게 쿠폰을 받으세요."
        : "운영진이 쿠폰을 전달하고 지급 완료로 기록했습니다.";
  await db
    .prepare(
      "INSERT INTO notifications(user_id,title,body,target_tab,event_id,created_at) VALUES (?,?,?,'missions',?,?)",
    )
    .run(
      claim.user_id,
      title,
      `${event.title} · ${mission.title}
${message}`,
      claim.event_id,
      now.toISOString(),
    );
  return { ok: true };
}
function text(value, max, label, fail) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail(400, `${label}을 1~${max}자로 입력해주세요.`);
  return value.trim();
}
function validDay(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}
export async function saveEvent(db, body, now, fail) {
  const title = text(body.title, 80, "이벤트 이름", fail);
  const description =
    typeof body.description === "string" && body.description.length <= 1000
      ? body.description.trim()
      : fail(400, "이벤트 소개는 1000자 이내로 입력해주세요.");
  if (
    !validDay(body.startDay) ||
    (body.endDay && !validDay(body.endDay)) ||
    (body.endDay && body.endDay < body.startDay)
  )
    fail(400, "이벤트 시작일과 종료일을 확인해주세요.");
  if (
    !Number.isInteger(body.rewardAmount) ||
    body.rewardAmount < 1 ||
    body.rewardAmount > 100000
  )
    fail(400, "쿠폰 금액은 1~100,000원으로 입력해주세요.");
  if (
    !Array.isArray(body.missions) ||
    body.missions.length < 1 ||
    body.missions.length > 10
  )
    fail(400, "미션은 1~10개로 설정해주세요.");
  const seen = new Set();
  const missions = body.missions.map((m) => {
    if (m.id !== undefined && (!Number.isInteger(m.id) || seen.has(m.id)))
      fail(400, "미션 ID를 확인해주세요.");
    if (m.id) seen.add(m.id);
    if (!["entry", "lunch", "recommend", "review"].includes(m.kind))
      fail(400, "참여 방식을 선택해주세요.");
    if (!Number.isInteger(m.capacity) || m.capacity < 1 || m.capacity > 500)
      fail(400, "지급 인원은 1~500명으로 입력해주세요.");
    if (typeof m.requiresReview !== "boolean")
      fail(400, "승인 방식을 선택해주세요.");
    return {
      ...m,
      title: text(m.title, 80, "미션 이름", fail),
      description: text(m.description, 1000, "이벤트 조건", fail),
    };
  });
  let eventId = body.id;
  if (eventId !== undefined) {
    if (!Number.isInteger(eventId)) fail(400, "이벤트를 확인해주세요.");
    const event = await db
      .prepare("SELECT * FROM mission_event WHERE id=?")
      .get(eventId);
    if (!event) fail(404, "이벤트를 찾을 수 없습니다.");
    const existing = await db
      .prepare("SELECT * FROM event_missions WHERE event_id=?")
      .all(eventId);
    const claims = await db
      .prepare("SELECT mission_id,status FROM mission_claims WHERE event_id=?")
      .all(eventId);
    if (claims.length && event.reward_amount !== body.rewardAmount)
      fail(
        409,
        "참여 이력이 있는 이벤트의 쿠폰 금액은 변경할 수 없습니다. 새 이벤트를 만들어주세요.",
      );
    for (const m of missions)
      if (m.id) {
        const before = existing.find((e) => e.id === m.id);
        if (!before) fail(400, "다른 이벤트의 미션은 수정할 수 없습니다.");
        const entries = claims.filter((c) => c.mission_id === m.id);
        if (entries.length && before.kind !== m.kind)
          fail(
            409,
            "참여 이력이 있는 미션의 참여 방식은 변경할 수 없습니다. 새 미션을 추가해주세요.",
          );
        if (m.capacity < entries.filter((c) => c.status !== "rejected").length)
          fail(409, "접수·승인·지급 인원보다 지급 인원을 줄일 수 없습니다.");
      }
    for (const old of existing)
      if (!missions.some((m) => m.id === old.id)) {
        if (claims.some((c) => c.mission_id === old.id))
          fail(
            409,
            "참여 이력이 있는 미션은 삭제할 수 없습니다. 이벤트 접수를 중단해주세요.",
          );
        await db.prepare("DELETE FROM event_missions WHERE id=?").run(old.id);
      }
    await db
      .prepare(
        "UPDATE mission_event SET title=?,description=?,start_day=?,end_day=?,reward_amount=? WHERE id=?",
      )
      .run(
        title,
        description,
        body.startDay,
        body.endDay || "",
        body.rewardAmount,
        eventId,
      );
  } else {
    if (missions.some((m) => m.id !== undefined))
      fail(400, "새 이벤트에는 기존 미션을 넣을 수 없습니다.");
    eventId = (
      await db
        .prepare(
          "INSERT INTO mission_event(title,description,start_day,end_day,reward_amount,created_at) VALUES (?,?,?,?,?,?) RETURNING id",
        )
        .get(
          title,
          description,
          body.startDay,
          body.endDay || "",
          body.rewardAmount,
          now.toISOString(),
        )
    ).id;
  }
  for (const m of missions) {
    if (m.id)
      await db
        .prepare(
          "UPDATE event_missions SET kind=?,title=?,description=?,capacity=?,requires_review=? WHERE id=?",
        )
        .run(
          m.kind,
          m.title,
          m.description,
          m.capacity,
          m.requiresReview ? 1 : 0,
          m.id,
        );
    else
      await db
        .prepare(
          "INSERT INTO event_missions(event_id,kind,title,description,capacity,requires_review) VALUES (?,?,?,?,?,?)",
        )
        .run(
          eventId,
          m.kind,
          m.title,
          m.description,
          m.capacity,
          m.requiresReview ? 1 : 0,
        );
  }
  return { ok: true, eventId };
}

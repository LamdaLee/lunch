const root = document.querySelector("#app");
const dialog = document.querySelector("#modal");
const state = {
  user: null,
  tab: "today",
  filter: "all",
  dashboard: null,
  admin: null,
  history: null,
};
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const trackName = (track) => (track === "OTHER" ? "교수·강사·운영진" : track);
const foodIcons = ["🍚", "🍜", "🥗", "🍱", "🍲", "🥘", "🍝", "🥟", "🍛"];
const foodCategories = [
  "중식",
  "한식",
  "국밥",
  "돈가스",
  "칼국수",
  "분식",
  "파스타",
  "비빔밥",
  "꼬마김밥",
];
function foodVisual(restaurant) {
  const specialty =
    restaurant.category === "한식" &&
    (restaurant.name === "조선명가" ||
      restaurant.naver_url === "https://naver.me/xUwPzf7e")
      ? { image: "yukgaejang-kalguksu.png", label: "육개장칼국수 · 계란찜" }
      : restaurant.category === "비빔밥" &&
          (restaurant.name === "교반" ||
            restaurant.naver_url === "https://naver.me/GEXhLegY")
        ? { image: "yukhoe-bibimbap.png", label: "육회비빔밥" }
        : null;
  if (specialty)
    return `<img class="dish-photo" src="/${specialty.image}" alt="${specialty.label} 음식 종류 대표 이미지" decoding="async"><span class="food-caption">${specialty.label} · 대표 이미지</span>`;

  if (restaurant.category === "꼬마김밥")
    return `<img class="kkoma-photo" src="/kkoma-gimbap.png" alt="꼬마김밥 음식 종류 대표 이미지" decoding="async"><span class="food-caption">꼬마김밥 · 대표 이미지</span>`;
  const index = foodCategories.indexOf(restaurant.category);
  if (index < 0)
    return `<span class="food" aria-hidden="true">${foodIcons[(restaurant.id - 1) % foodIcons.length]}</span><span class="number" aria-hidden="true">${String(restaurant.id).padStart(2, "0")}</span>`;
  return `<img class="food-photo" src="/food-categories.png" alt="${esc(restaurant.category)} 음식 종류 대표 이미지" decoding="async" style="left:-${(index % 4) * 100}%;transform:translateY(-${index < 4 ? 25 : 75}%)"><span class="food-caption">${esc(restaurant.category)} · 대표 이미지</span>`;
}
let refreshTimer, toastTimer;
async function api(path, method = "GET", body) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: method !== "GET" ? { "Content-Type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (
      response.status === 401 &&
      !["/login", "/register"].includes(path) &&
      state.user
    ) {
      state.user = null;
      renderAuth();
    }
    throw new Error(data.error || "요청을 처리하지 못했습니다.");
  }
  return data;
}
function toast(message) {
  const target = document.querySelector("#toast");
  target.textContent = message;
  target.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => target.classList.remove("show"), 4000);
}
function brand() {
  return '<a class="brand" href="/" aria-label="런치패스 홈"><span class="brandmark">⌁</span><span>런치패스<small>LUNCH, TOGETHER</small></span></a>';
}
function header() {
  return `<header class="topbar">${brand()}<div class="top-right">${state.user ? `<span class="pill gray">${esc(trackName(state.user.track))}</span><button class="btn ghost small profile" data-action="password" aria-label="${esc(state.user.name)} 비밀번호 변경"><span class="avatar">${esc(state.user.name[0])}</span><b>${esc(state.user.name)}</b></button><button class="btn ghost small" data-action="logout">로그아웃</button>` : '<span class="pill red">AX · SF</span>'}</div></header>`;
}
function footer() {
  return '<footer class="footer"><span>런치패스 · 함께하는 점심</span><span>종이 식권 지참 · 지원 한도 11,000원</span></footer>';
}
function renderAuth(setupNeeded = false, setupAvailable = false) {
  clearInterval(refreshTimer);
  root.innerHTML = `${header()}<main class="auth-layout"><section class="auth-story"><div><span class="eyebrow">A LITTLE BREAK, TOGETHER</span><h1>오늘 점심,<br>조금 더 여유롭게.</h1><p>어디로 갈지 고민하는 시간은 줄이고,<br>함께 먹는 즐거움은 늘려요.</p></div><div class="auth-art" aria-hidden="true">🍱</div><div class="small-note"><span>09:00 선택 시작</span><span>12:00 마감</span><span>12:50 점심</span></div></section><section class="auth-form"><span class="eyebrow">WELCOME TO LUNCHPASS</span><h2>반가워요! 👋</h2><p>학번으로 로그인하고 오늘의 식당을 골라보세요.</p>${setupNeeded ? `<div class="notice">최초 관리자 설정이 필요합니다.${setupAvailable ? " 아래 버튼으로 관리자 계정을 만들어주세요." : " 운영진이 서버에서 초기 설정을 완료하면 이용할 수 있어요."}</div>${setupAvailable ? '<button class="btn full" data-action="setup">최초 관리자 설정</button>' : ""}` : ""}<form id="auth-form"><label class="field">학번 / 로그인 ID<input name="loginId" autocomplete="username" required maxlength="40" placeholder="학번 또는 운영진의 로그인 ID"></label><label class="field">비밀번호<input name="password" type="password" autocomplete="current-password" required minlength="8" maxlength="128" placeholder="처음에는 전달받은 초기 비밀번호"></label><p class="form-error" role="alert" id="auth-error"></p><button class="btn full" type="submit" ${setupNeeded ? "disabled" : ""}>로그인 <span aria-hidden="true">→</span></button></form><p class="footnote" style="margin-top:25px">처음 이용하나요? 운영진에게 학번과 초기 비밀번호를 받아주세요.<br>첫 로그인에서 내 비밀번호로 변경할 수 있어요.</p></section></main>`;
}
function renderFirstPassword() {
  clearInterval(refreshTimer);
  root.innerHTML = `${header()}<main class="restaurant-view"><section class="panel"><span class="eyebrow">YOUR ACCOUNT, YOUR PASSWORD</span><h2 style="margin-top:10px">${esc(state.user.name)} 님, 반가워요!</h2><p class="muted" style="margin:12px 0 25px">처음 로그인했거나 비밀번호가 초기화되었어요.<br>이용하기 전에 나만의 비밀번호로 바꿔주세요.</p><form id="first-password-form"><label class="field">초기 비밀번호<input name="current" type="password" required autocomplete="current-password" maxlength="128"></label><label class="field">새 비밀번호<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="new-password" placeholder="8자 이상, 초기 비밀번호와 다르게"></label><label class="field">새 비밀번호 확인<input name="confirm" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label><p class="form-error" id="first-password-error" role="alert"></p><button class="btn full" type="submit">비밀번호 변경하고 시작하기 →</button></form></section></main>`;
}
async function afterLogin() {
  state.user = (await api("/status")).user;
  if (state.user.must_change) {
    renderFirstPassword();
    return;
  }
  state.tab = "today";
  await loadToday();
  startRefresh();
}
function setupAdmin() {
  modal(
    '<h2>최초 관리자 설정</h2><p>Vercel 환경 변수에 설정한 초기 설정 키로 관리자 계정을 만드세요. 한 번만 사용할 수 있습니다.</p><form id="setup-form"><label class="field">초기 설정 키<input name="key" type="password" required autocomplete="off" maxlength="200"></label><label class="field">관리자 이름<input name="name" required maxlength="40" value="운영관리자"></label><label class="field">로그인 ID<input name="loginId" required maxlength="40" value="admin" autocomplete="username"></label><label class="field">비밀번호<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label><label class="field">비밀번호 확인<input name="confirm" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label><p class="form-error" id="setup-error" role="alert"></p><div class="modal-actions"><button class="btn secondary" type="button" data-action="close-modal">닫기</button><button class="btn" type="submit">관리자 생성</button></div></form>',
  );
  document.querySelector("#setup-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target),
      button = event.target.querySelector("[type=submit]");
    button.disabled = true;
    try {
      if (form.get("password") !== form.get("confirm"))
        throw new Error("비밀번호가 일치하지 않습니다.");
      await api("/setup", "POST", Object.fromEntries(form));
      dialog.close();
      renderAuth();
      toast("관리자 계정을 만들었어요. 설정한 ID로 로그인해주세요.");
    } catch (e) {
      document.querySelector("#setup-error").textContent = e.message;
      button.disabled = false;
    }
  };
}
function shell(content) {
  root.innerHTML = `${header()}<main class="shell"><nav class="nav" aria-label="메인 메뉴"><button data-tab="today" class="${state.tab === "today" ? "active" : ""}">오늘의 식당</button><button data-tab="history" class="${state.tab === "history" ? "active" : ""}">내 식사 기록</button><button data-action="password">비밀번호 변경</button><button data-tab="board" class="${state.tab === "board" ? "active" : ""}">우리의 게시판</button>${state.user.role === "admin" ? `<button data-tab="admin" class="${state.tab === "admin" ? "active" : ""}">운영 관리</button>` : ""}</nav>${content}${footer()}</main>`;
}
function phasePill(clock) {
  const texts = {
    before: "09:00에 선택이 열려요",
    open: "식당 선택 중",
    closed: "오늘 선택 마감",
  };
  return `<span class="pill ${clock.phase === "open" ? "green" : "gray"}"><i class="dot"></i>${texts[clock.phase]}</span>`;
}
function dateLabel(day) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Seoul",
  }).format(new Date(`${day}T12:00:00+09:00`));
}
function renderToday() {
  const { restaurants, reservation, clock } = state.dashboard;
  const visible =
    state.filter === "less"
      ? [...restaurants].sort((a, b) => a.count - b.count)
      : restaurants;
  const count = restaurants.reduce((sum, r) => sum + r.count, 0);
  const cards = visible
    .map((r, i) => {
      const selected = reservation?.restaurant_id === r.id;
      return `<article class="restaurant-card ${selected ? "selected" : ""}"><div class="card-visual tone${i % 4} ${foodCategories.includes(r.category) ? "has-photo" : ""}">${foodVisual(r)}<span class="pill ${selected ? "red" : "gray"}">${selected ? "✓ 내 선택" : `${r.count}명 예정`}</span></div><div class="card-body"><h3>${esc(r.name)}</h3><p class="desc">${esc(r.description || "함께 갈 사람 수를 보고 오늘의 식당을 골라요.")}</p>${r.menu ? `<div class="menu">추천 메뉴 · ${esc(r.menu)}</div>` : ""}${r.naver_url ? `<a class="btn secondary full small restaurant-naver" href="${esc(r.naver_url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(r.name)} 네이버에서 보기 (새 창)">네이버에서 보기 ↗</a>` : ""}<div class="capacity"><span>오늘 갈 사람 <strong>${r.count}명</strong></span><span>12:50–14:00</span></div><p class="footnote">${r.totals.map((t) => `${esc(trackName(t.track))} ${t.count}명`).join(" · ") || "아직 선택한 사람이 없어요."}</p><button class="btn full ${selected || clock.phase !== "open" ? "secondary" : ""}" data-action="reserve" data-id="${r.id}" ${selected || clock.phase !== "open" ? "disabled" : ""}>${selected ? "✓ 오늘 내 선택" : clock.phase !== "open" ? (clock.phase === "before" ? "09:00 선택 시작" : "오늘 선택 마감") : reservation ? "이 식당으로 변경" : "나도 여기 갈래요"}</button></div></article>`;
    })
    .join("");
  shell(
    `<section class="hero"><div><time class="today-date" datetime="${clock.day}">${dateLabel(clock.day)}</time><span class="eyebrow lunch-label">TODAY'S LUNCH</span><h1>오늘은 어디서 먹을까요?</h1><p class="intro">어디로 몇 명이 갈지 확인하고, 함께 조율해요.</p></div><div class="hero-art" aria-hidden="true"><div class="plate">🍚</div></div></section><div class="info-strip"><div class="info-parts"><span><b>선택·취소</b>09:00–12:00</span><span><b>식사 시간</b>12:50–14:00</span></div>${phasePill(clock)}</div><div class="content-layout"><section><div class="section-head"><div><h2>제휴 식당 <span class="muted">${restaurants.length}</span></h2><p>오늘 ${count}명이 갈 식당을 선택했어요.</p></div><button class="btn ghost small" data-action="refresh">↻ 새로고침</button></div><div class="filter-row"><button class="${state.filter === "all" ? "active" : ""}" data-filter="all">전체 식당</button><button class="${state.filter === "less" ? "active" : ""}" data-filter="less">인원 적은 순</button></div>${cards ? `<div class="cards">${cards}</div>` : '<div class="empty"><h3>표시된 식당이 없어요</h3><p>운영진에게 식당 목록을 확인해주세요.</p></div>'}</section><aside class="side"><section class="side-card reservation-summary"><span class="eyebrow">MY LUNCH PLAN</span><h3 style="margin-top:6px">오늘 가려는 식당</h3>${reservation ? `<div class="reservation-name">${esc(reservation.name)}</div><div class="detail-line"><span>식사 시간</span><b>12:50–14:00</b></div><hr><p class="footnote">오늘의 선택을 공유했어요. 종이 식권을 꼭 가져가세요.</p><button class="btn secondary full small" data-action="cancel" ${clock.phase !== "open" ? "disabled" : ""}>${clock.phase === "open" ? "선택 취소" : "선택·취소 마감"}</button>` : '<p class="empty-reservation">아직 선택한 식당이 없어요.<br>마음에 드는 식당을 골라주세요.</p><span class="pill red">하루 한 곳 선택</span>'}</section><section class="side-card"><h3>함께 점심을 조율해요</h3><p class="muted">사람이 많이 모인 식당은 다른 곳도 살펴보세요. 함께 갈 친구를 찾거나 식당 소식을 나눌 수 있어요.</p><button class="btn secondary full small" data-tab="board">게시판에서 이야기하기 →</button></section><section class="side-card"><h3>점심 이용 안내</h3><div class="steps"><div class="step"><span class="step-number">01</span><div><b>오전 9시부터 선택</b><small>학번으로 로그인하고 갈 식당을 골라요.</small></div></div><div class="step"><span class="step-number">02</span><div><b>낮 12시에 선택 마감</b><small>변경·취소도 12시 전에 해주세요.</small></div></div><div class="step"><span class="step-number">03</span><div><b>종이 식권으로 식사</b><small>11,000원 초과 금액은 직접 결제해요.</small></div></div></div></section><p class="footnote">방문 예정 인원을 공유하는 페이지입니다.<br>식당 예약이나 자리 확보를 의미하지 않습니다.<br>인원은 30초마다 자동 갱신됩니다.</p></aside></div>`,
  );
}
async function loadToday() {
  state.dashboard = await api("/dashboard");
  state.user = state.dashboard.user;
  if (state.tab === "today") renderToday();
}
async function loadHistory(before) {
  const data = await api(
    `/history${before ? `?before=${encodeURIComponent(before)}` : ""}`,
  );
  if (state.tab !== "history") return;
  state.history = {
    ...data,
    records: before
      ? [...state.history.records, ...data.records]
      : data.records,
  };
  const { records, day, nextBefore } = state.history;
  shell(
    `<section class="hero"><div><span class="eyebrow">MY LUNCH HISTORY</span><h1>내 식사 기록</h1><p class="intro">날짜별로 내가 선택했던 식당을 확인해요.</p></div></section><section class="panel"><div class="section-head"><h2>${esc(state.user.name)} 님의 점심 선택 내역</h2><button class="btn ghost small" data-action="refresh">↻ 새로고침</button></div><p class="footnote">식사 시간은 12:50–14:00입니다. 실제 방문 여부를 확인하는 기능은 없으며, 취소한 선택은 표시되지 않습니다.</p>${records.length ? `<div class="table-wrap"><table><thead><tr><th>날짜</th><th>식당</th><th>기록</th></tr></thead><tbody>${records.map((record) => `<tr><td><time datetime="${esc(record.day)}">${esc(record.day)}<br><small class="muted">${dateLabel(record.day)}</small></time></td><td><b>${esc(record.restaurant)}</b></td><td><span class="pill ${record.day === day ? "red" : "gray"}">${record.day === day ? "오늘의 선택" : "선택 내역"}</span></td></tr>`).join("")}</tbody></table></div>${nextBefore ? '<button class="btn secondary full" data-action="more-history">이전 기록 더 보기</button>' : ""}` : '<div class="empty"><div class="empty-icon" aria-hidden="true">🍽️</div><h3>아직 식당 선택 기록이 없어요</h3><p>오늘 갈 식당을 고르면 여기에서 확인할 수 있어요.</p><button class="btn" data-tab="today">오늘의 식당 보기 →</button></div>'}</section>`,
  );
}
async function loadBoard() {
  const { posts } = await api("/posts");
  if (state.tab !== "board") return;
  shell(
    `<section class="hero"><div><span class="eyebrow">OUR LITTLE LUNCH BOARD</span><h1>한 끼 사이, 한마디.</h1><p class="intro">오늘의 메뉴부터 작은 공지까지, 함께 나누는 공간이에요.</p></div><span class="hero-art" aria-hidden="true"><span class="plate">💬</span></span></section><form id="post-form" class="panel post-composer"><label for="post-body"><b>오늘 나누고 싶은 이야기</b></label><textarea id="post-body" name="body" maxlength="1000" required placeholder="추천 메뉴, 식당 소식, 함께 나눌 이야기를 남겨주세요."></textarea><div class="composer-actions">${state.user.role === "admin" ? '<label class="check"><input type="checkbox" name="pinned">운영 공지로 상단 고정</label>' : '<small class="muted">모두가 읽는 공간이에요. 서로를 배려해주세요.</small>'}<button class="btn small" type="submit">게시하기 ↗</button></div></form><div class="section-head"><h2>우리의 이야기 <span class="muted">${posts.length}</span></h2><button class="btn ghost small" data-action="refresh">↻ 새로고침</button></div>${posts.length ? `<section class="board-grid">${posts.map((p) => `<article class="post ${p.pinned ? "pinned" : ""}"><div class="post-top"><b>${p.pinned ? "📌 운영 공지" : esc(trackName(p.track))}</b><span>${esc(p.name)}</span></div><div class="post-body">${esc(p.body)}</div><div class="post-bottom"><time datetime="${esc(p.created_at)}">${new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" }).format(new Date(p.created_at))}</time>${p.user_id === state.user.id || state.user.role === "admin" ? `<button class="btn ghost small" data-action="delete-post" data-id="${p.id}">삭제</button>` : ""}</div></article>`).join("")}</section>` : '<div class="empty"><div class="empty-icon">📝</div><h3>첫 번째 이야기를 남겨주세요.</h3><p>맛있었던 메뉴나 함께 나누고 싶은 소식도 좋아요.</p></div>'}`,
  );
}
async function loadAdmin(day) {
  const data = await api(
    `/admin/overview${day ? `?day=${encodeURIComponent(day)}` : ""}`,
  );
  state.admin = data;
  if (state.tab !== "admin") return;
  const options = data.tracks
    .map((t) => `<option value="${esc(t)}">${esc(trackName(t))}</option>`)
    .join("");
  shell(
    `<div class="section-head"><div><span class="eyebrow">OPERATIONS</span><h1 style="font-size:30px;margin-top:7px">점심 운영 대시보드</h1><p>식당별 인원과 이용자 명단을 한눈에 확인하세요.</p></div><label class="field date-field">조회 날짜<input type="date" id="admin-day" value="${data.day}"></label></div><div class="stats"><div class="stat"><span>선택한 날짜 예정 인원</span><strong>${data.reservations.length}<small>명</small></strong></div><div class="stat"><span>표시 중인 식당</span><strong>${data.restaurants.filter((r) => r.listed).length}<small>곳</small></strong></div><div class="stat"><span>등록된 이용자</span><strong>${data.users.length}<small>명</small></strong></div></div><section class="panel"><div class="section-head"><div><h2>식당별 예정 인원</h2><p>정원 설정 없이 인원을 공유합니다. 식당에서 따로 조작할 필요가 없어요.</p></div><button class="btn small" data-action="edit-restaurant">+ 식당 추가</button></div><div class="table-wrap"><table><thead><tr><th>식당</th><th>예정 인원</th><th>표시 상태</th><th>관리</th></tr></thead><tbody>${data.restaurants.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${r.count}명</td><td><span class="pill ${r.listed ? "green" : "gray"}">${r.listed ? "표시 중" : "숨김"}</span></td><td><div class="table-actions"><button class="btn secondary small" data-action="edit-restaurant" data-id="${r.id}">수정</button><button class="btn secondary small" data-action="restaurant-link" data-id="${r.id}">인원 보기 링크</button></div></td></tr>`).join("")}</tbody></table></div></section><section class="panel"><div class="section-head"><h2>식당 선택 명단</h2><button class="btn secondary small" data-action="export" ${data.reservations.length ? "" : "disabled"}>CSV 다운로드 ↓</button></div>${data.reservations.length ? `<div class="table-wrap"><table><thead><tr><th>식당</th><th>이름</th><th>학번 / ID</th><th>구분</th></tr></thead><tbody>${data.reservations.map((r) => `<tr><td>${esc(r.restaurant)}</td><td>${esc(r.name)}</td><td>${esc(r.login_id)}</td><td><span class="pill gray">${esc(trackName(r.track))}</span></td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">선택한 날짜의 식당 선택이 없습니다.</p>'}</section><section class="panel"><div class="section-head"><div><h2>이용자 등록</h2><p>이름·학번·반을 등록하고 초기 비밀번호를 전달해주세요. 운영진 권한은 전체 명단과 계정을 관리할 수 있습니다.</p></div></div><form id="user-form" class="inline-form"><label class="field">이름<input name="name" required maxlength="40" placeholder="김민수"></label><label class="field">학번 / 로그인 ID<input name="loginId" required maxlength="40" placeholder="AX2026001"></label><label class="field">반 / 구분<select name="track">${options}</select></label><label class="field">권한<select name="role"><option value="member">일반 이용자</option><option value="admin">운영진 (관리자)</option></select></label><label class="field">초기 비밀번호<input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" placeholder="비워두면 자동 생성"></label><button class="btn" type="submit">이용자 등록</button></form><details style="margin-top:24px"><summary>여러 명 한 번에 등록하기</summary><form id="bulk-user-form" style="margin-top:16px"><label class="field">한 줄에 이름,학번,반을 입력해주세요<textarea name="members" required placeholder="김민수,AX2026001,AX&#10;이서연,SF2026001,SF&#10;박교수,STAFF001,OTHER" maxlength="10000"></textarea></label><p class="footnote">등록된 반: ${data.tracks.map((t) => esc(t)).join(" / ")}. 개인별 초기 비밀번호가 담긴 CSV를 다운로드합니다. 이 파일은 운영진만 보관하고 각 계정 정보는 당사자에게만 전달해주세요.</p><button class="btn small" type="submit">계정 등록 · 초기 비밀번호 CSV ↓</button></form></details></section><section class="panel"><div class="section-head"><div><h2>반 관리</h2><p>새 기수와 반을 추가할 수 있어요.</p></div></div><div class="filter-row">${data.tracks.map((t) => `<span class="pill gray">${esc(trackName(t))}</span>`).join("")}</div><form id="track-form" class="inline-form"><label class="field">새 반 이름<input name="name" required maxlength="30" placeholder="예: AX3기"></label><button class="btn secondary" type="submit">반 추가</button></form></section><section class="panel"><div class="section-head"><h2>등록된 이용자</h2></div><div class="table-wrap"><table><thead><tr><th>이름</th><th>학번 / ID</th><th>구분</th><th>권한 / 계정 상태</th><th>관리</th></tr></thead><tbody>${data.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.login_id)}</td><td>${esc(trackName(u.track))}</td><td>${u.role === "admin" ? "운영진" : "일반 이용자"} · ${u.must_change ? "첫 로그인 대기" : "이용 중"}</td><td>${u.id !== state.user.id ? `<div class="table-actions"><button class="btn secondary small" data-action="change-role" data-id="${u.id}">${u.role === "admin" ? "일반 이용자로 변경" : "운영진으로 지정"}</button><button class="btn secondary small" data-action="reset-password" data-id="${u.id}">비밀번호 초기화</button></div>` : "—"}</td></tr>`).join("")}</tbody></table></div></section>`,
  );
}
function accountDetails(account) {
  modal(
    `<h2>${esc(account.name)} 님 계정</h2><p>이 정보를 당사자에게만 전달해주세요. 첫 로그인에서 비밀번호를 반드시 바꿔야 합니다.</p><div class="code-output">학번 / ID: ${esc(account.loginId)}<br>초기 비밀번호: ${esc(account.password)}</div><div class="modal-actions"><button class="btn secondary" data-action="close-modal">닫기</button><button class="btn" id="copy-account">복사하기</button></div>`,
  );
  document.querySelector("#copy-account").onclick = () =>
    copyText(
      `학번 / ID: ${account.loginId}\n초기 비밀번호: ${account.password}`,
    );
}
function modal(content) {
  dialog.innerHTML = content;
  dialog.showModal();
}
function confirmAction(title, description, callback, label = "확인") {
  modal(
    `<h2>${esc(title)}</h2><p>${esc(description)}</p><div class="modal-actions"><button class="btn secondary" id="confirm-no">돌아가기</button><button class="btn" id="confirm-yes">${esc(label)}</button></div>`,
  );
  document.querySelector("#confirm-no").onclick = () => dialog.close();
  document.querySelector("#confirm-yes").onclick = async (event) => {
    event.target.disabled = true;
    try {
      await callback();
      dialog.close();
    } catch (e) {
      toast(e.message);
      event.target.disabled = false;
    }
  };
}
function editRestaurant(id) {
  const r = state.admin.restaurants.find((r) => r.id === id) || {
    name: "",
    description: "",
    menu: "",
    listed: 1,
    naver_url: "",
    category: "",
  };
  modal(
    `<h2>${id ? "식당 설정" : "새 식당 추가"}</h2><p>식당 안내를 수정하거나 이용할 수 없는 식당을 숨길 수 있어요.</p><form id="restaurant-form"><label class="field">식당 이름<input name="name" value="${esc(r.name)}" required maxlength="60"></label><label class="field">음식 종류<select name="category"><option value="">미지정</option>${foodCategories.map((category) => `<option value="${category}" ${r.category === category ? "selected" : ""}>${category}</option>`).join("")}</select></label><label class="field">식당 소개<input name="description" value="${esc(r.description)}" maxlength="300" placeholder="예: 공간이 아담해요. 여유롭게 방문해주세요."></label><label class="field">추천 메뉴<input name="menu" value="${esc(r.menu)}" maxlength="200" placeholder="예: 제육덮밥 · 김치찌개"></label><label class="field">네이버 링크<input name="naverUrl" type="url" value="${esc(r.naver_url)}" maxlength="500" placeholder="https://naver.me/..."></label><label class="check"><input type="checkbox" name="listed" ${r.listed ? "checked" : ""}>학생 화면에 표시</label><p class="form-error" id="restaurant-error" role="alert"></p><div class="modal-actions"><button type="button" class="btn secondary" data-action="close-modal">닫기</button><button class="btn" type="submit">저장하기</button></div></form>`,
  );
  document.querySelector("#restaurant-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target),
      button = event.target.querySelector("[type=submit]");
    button.disabled = true;
    try {
      await api("/admin/restaurants", "POST", {
        id,
        name: form.get("name"),
        description: form.get("description"),
        menu: form.get("menu"),
        naverUrl: form.get("naverUrl"),
        category: form.get("category"),
        listed: form.has("listed"),
      });
      dialog.close();
      await loadAdmin(state.admin.day);
      toast("식당 설정을 저장했어요.");
    } catch (e) {
      document.querySelector("#restaurant-error").textContent = e.message;
      button.disabled = false;
    }
  };
}
function changePassword() {
  modal(
    '<h2>비밀번호 변경</h2><p>새 비밀번호는 8자 이상 입력해주세요. 변경하면 다른 기기의 로그인은 종료됩니다.</p><form id="password-form"><label class="field">현재 비밀번호<input type="password" name="current" required autocomplete="current-password" maxlength="128"></label><label class="field">새 비밀번호<input type="password" name="password" required minlength="8" maxlength="128" autocomplete="new-password"></label><label class="field">새 비밀번호 확인<input type="password" name="confirm" required minlength="8" maxlength="128" autocomplete="new-password"></label><p class="form-error" id="password-error" role="alert"></p><div class="modal-actions"><button class="btn secondary" type="button" data-action="close-modal">닫기</button><button class="btn" type="submit">변경하기</button></div></form>',
  );
  document.querySelector("#password-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target),
      button = event.target.querySelector("[type=submit]");
    button.disabled = true;
    try {
      if (form.get("password") !== form.get("confirm"))
        throw new Error("새 비밀번호가 일치하지 않습니다.");
      await api("/password", "POST", {
        current: form.get("current"),
        password: form.get("password"),
      });
      dialog.close();
      toast("비밀번호를 변경했어요.");
    } catch (e) {
      document.querySelector("#password-error").textContent = e.message;
      button.disabled = false;
    }
  };
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("복사했어요.");
  } catch {
    toast("자동 복사가 지원되지 않습니다. 표시된 내용을 선택해 복사해주세요.");
  }
}
function exportCSV() {
  const protect = (value) => {
    const text = String(value);
    return `"${(/^[\s]*[=+@\-]/.test(text) ? "'" : "") + text.replace(/"/g, '""')}"`;
  };
  const rows = [
    ["날짜", "식당", "이름", "학번/ID", "구분"],
    ...state.admin.reservations.map((r) => [
      state.admin.day,
      r.restaurant,
      r.name,
      r.login_id,
      trackName(r.track),
    ]),
  ];
  const blob = new Blob(
    ["\uFEFF" + rows.map((row) => row.map(protect).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `점심선택-${state.admin.day}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadAccounts(members) {
  const cell = (value) =>
    `"${(/^[\s]*[=+@\-]/.test(String(value)) ? "'" : "") + String(value).replace(/"/g, '""')}"`;
  const rows = [
    ["이름", "학번/ID", "구분", "초기 비밀번호"],
    ...members.map((m) => [m.name, m.loginId, m.track, m.password]),
  ];
  const blob = new Blob(
    ["\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "런치패스-초기계정.csv";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function renderRestaurant() {
  const accessToken =
    new URLSearchParams(location.search).get("token") ||
    sessionStorage.getItem("restaurantToken");
  if (new URLSearchParams(location.search).has("token")) {
    sessionStorage.setItem("restaurantToken", accessToken);
    history.replaceState(null, "", "/restaurant");
  }
  const data = await api(
    `/restaurant?token=${encodeURIComponent(accessToken || "")}`,
  );
  const updated = new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date());
  root.innerHTML = `${header()}<main class="restaurant-view"><section class="hero"><span class="eyebrow">RESTAURANT PARTNER</span><h1 style="margin-top:10px">${esc(data.restaurant.name)}</h1><p class="muted">${dateLabel(data.clock.day)} 방문 예정 인원입니다.</p></section><div class="info-strip"><span><b>식사 시간</b> 12:50–14:00</span>${phasePill(data.clock)}</div><section class="big-count"><span class="muted">오늘 이 식당을 선택한 사람</span><div class="count">${data.count}<span>명</span></div><div class="track-counts">${data.totals.length ? data.totals.map((row) => `<span>${esc(trackName(row.track))} <b>${row.count}명</b></span>`).join("") : "<span>아직 선택한 사람이 없습니다.</span>"}</div></section><div class="notice">${data.clock.phase === "closed" ? "오늘 식당 선택이 마감되었습니다." : data.clock.phase === "before" ? "식당 선택은 오전 9시부터 시작됩니다." : "낮 12시까지 선택과 취소가 가능해 인원이 변경될 수 있습니다."} 방문 의향을 공유하는 집계이며 실제 방문 인원은 다를 수 있습니다. 이 페이지에서 설정할 것은 없습니다.</div><section class="side-card"><h3>식당 이용 안내</h3><p class="muted" style="font-size:14px">손님은 종이 식권을 제시합니다. 지원 한도는 11,000원이며, 초과 금액은 손님에게 직접 결제받아주세요. 정산 일정은 운영진에게 문의해주세요.</p></section><div class="auto-refresh"><span>30초마다 자동 갱신 · ${updated} 확인</span><button class="btn secondary small" data-action="restaurant-refresh">↻ 새로고침</button></div>${footer()}</main>`;
}
async function selectTab(tab) {
  state.tab = tab;
  if (tab === "today") await loadToday();
  else if (tab === "history") await loadHistory();
  else if (tab === "board") await loadBoard();
  else if (tab === "admin") await loadAdmin();
}
document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target || target.disabled) return;
  try {
    if (target.dataset.tab) return await selectTab(target.dataset.tab);
    if (target.dataset.filter) {
      state.filter = target.dataset.filter;
      renderToday();
      return;
    }
    const id = Number(target.dataset.id);
    switch (target.dataset.action) {
      case "setup":
        setupAdmin();
        break;
      case "more-history":
        target.disabled = true;
        try {
          await loadHistory(state.history.nextBefore);
        } finally {
          target.disabled = false;
        }
        break;
      case "password":
        if (state.user.must_change) renderFirstPassword();
        else changePassword();
        break;
      case "logout":
        await api("/logout", "POST", {});
        state.user = null;
        state.admin = null;
        state.dashboard = null;
        state.history = null;
        renderAuth();
        break;
      case "refresh":
        await selectTab(state.tab);
        toast("최신 정보를 확인했어요.");
        break;
      case "reserve":
        target.disabled = true;
        try {
          await api("/choice", "POST", { restaurantId: id });
          await loadToday();
          toast("오늘 갈 식당을 선택했어요.");
        } finally {
          target.disabled = false;
        }
        break;
      case "cancel":
        target.disabled = true;
        try {
          await api("/choice", "DELETE", {});
          await loadToday();
          toast("선택을 취소했어요.");
        } finally {
          target.disabled = false;
        }
        break;
      case "change-role": {
        const user = state.admin.users.find((u) => u.id === id);
        const role = user.role === "admin" ? "member" : "admin";
        confirmAction(
          "이용자 권한을 변경할까요?",
          `${user.name} 님을 ${role === "admin" ? "운영진으로 지정합니다. 전체 명단과 계정을 관리할 수 있습니다." : "일반 이용자로 변경합니다."} 변경 후 다시 로그인해야 합니다.`,
          async () => {
            await api("/admin/user-role", "POST", { id, role });
            await loadAdmin(state.admin.day);
            toast("권한을 변경했어요. 해당 이용자는 다시 로그인해주세요.");
          },
          "권한 변경",
        );
        break;
      }
      case "delete-post":
        confirmAction(
          "게시글을 삭제할까요?",
          "삭제한 게시글은 복구할 수 없습니다.",
          async () => {
            await api(`/posts/${id}`, "DELETE", {});
            await loadBoard();
            toast("게시글을 삭제했어요.");
          },
          "삭제",
        );
        break;
      case "edit-restaurant":
        editRestaurant(id || undefined);
        break;
      case "close-modal":
        dialog.close();
        break;
      case "export":
        exportCSV();
        break;
      case "reset-password":
        confirmAction(
          "비밀번호를 초기화할까요?",
          "이 이용자의 모든 로그인이 종료되고 새 초기 비밀번호가 발급됩니다.",
          async () => {
            const account = await api("/admin/reset-password", "POST", { id });
            dialog.close();
            await loadAdmin(state.admin.day);
            setTimeout(() => accountDetails(account), 0);
          },
          "초기화",
        );
        break;
      case "restaurant-refresh":
        await renderRestaurant();
        break;
      case "restaurant-link": {
        const r = state.admin.restaurants.find((r) => r.id === id);
        const link = `${location.origin}/restaurant?token=${encodeURIComponent(r.access_token)}`;
        modal(
          `<h2>${esc(r.name)} 전용 링크</h2><p>이 링크는 이 식당의 예정 인원만 보여줍니다. 필요할 때 공유할 수 있으며 식당이 설정하거나 입력할 내용은 없습니다.</p><div class="code-output">${esc(link)}</div><div class="modal-actions"><button class="btn secondary small" id="rotate-link">링크 재발급</button><button class="btn secondary small" data-action="close-modal">닫기</button><button class="btn small" id="copy-link">복사하기</button></div>`,
        );
        document.querySelector("#copy-link").onclick = () => copyText(link);
        document.querySelector("#rotate-link").onclick = () =>
          confirmAction(
            "인원 보기 링크를 재발급할까요?",
            "기존 링크는 즉시 사용할 수 없게 됩니다. 새 링크를 식당에 다시 전달해주세요.",
            async () => {
              await api("/admin/rotate-link", "POST", { id });
              await loadAdmin(state.admin.day);
              toast(
                "재발급했어요. 인원 보기 링크 버튼으로 새 링크를 확인하세요.",
              );
            },
            "재발급",
          );
        break;
      }
    }
  } catch (e) {
    toast(e.message);
  }
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (
    ![
      "auth-form",
      "post-form",
      "user-form",
      "bulk-user-form",
      "track-form",
      "first-password-form",
    ].includes(form.id)
  )
    return;
  event.preventDefault();
  const data = new FormData(form),
    button = form.querySelector("[type=submit]");
  button.disabled = true;
  try {
    if (form.id === "auth-form") {
      await api("/login", "POST", Object.fromEntries(data));
      await afterLogin();
      toast("반가워요. 오늘도 맛있는 점심 드세요!");
    } else if (form.id === "first-password-form") {
      if (data.get("password") !== data.get("confirm"))
        throw new Error("새 비밀번호가 일치하지 않습니다.");
      await api("/password", "POST", {
        current: data.get("current"),
        password: data.get("password"),
      });
      await afterLogin();
      toast("비밀번호를 변경했어요.");
    } else if (form.id === "post-form") {
      await api("/posts", "POST", {
        body: data.get("body"),
        pinned: data.has("pinned"),
      });
      await loadBoard();
      toast("이야기를 게시했어요.");
    } else if (form.id === "bulk-user-form") {
      const members = String(data.get("members"))
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line, index) => {
          const parts = line.split(",").map((s) => s.trim());
          if (
            parts.length !== 3 ||
            !parts[0] ||
            !parts[1] ||
            !state.admin.tracks.includes(parts[2])
          )
            throw new Error(
              `${index + 1}번째 줄: 이름,학번,반 형식을 확인해주세요.`,
            );
          return { name: parts[0], loginId: parts[1], track: parts[2] };
        });
      const result = await api("/admin/bulk-users", "POST", { members });
      downloadAccounts(result.members);
      await loadAdmin(state.admin.day);
      toast(
        `${result.members.length}명의 계정을 등록했어요. 초기 비밀번호 CSV를 안전하게 보관해주세요.`,
      );
    } else if (form.id === "track-form") {
      await api("/admin/tracks", "POST", { name: data.get("name") });
      await loadAdmin(state.admin.day);
      toast("새 반을 추가했어요.");
    } else {
      const account = await api("/admin/users", "POST", {
        name: data.get("name"),
        loginId: data.get("loginId"),
        track: data.get("track"),
        role: data.get("role"),
        password: data.get("password"),
      });
      await loadAdmin(state.admin.day);
      accountDetails(account);
    }
  } catch (e) {
    const target =
      form.id === "auth-form"
        ? "#auth-error"
        : form.id === "first-password-form"
          ? "#first-password-error"
          : null;
    if (target && document.querySelector(target))
      document.querySelector(target).textContent = e.message;
    else toast(e.message);
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("change", async (event) => {
  if (event.target.id === "admin-day")
    try {
      await loadAdmin(event.target.value);
    } catch (e) {
      toast(e.message);
    }
});
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    const box = dialog.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      dialog.close();
  }
});
function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if (document.hidden || dialog.open) return;
    try {
      if (location.pathname === "/restaurant") await renderRestaurant();
      else if (state.user && state.tab === "today") await loadToday();
      else if (
        state.user &&
        state.tab === "admin" &&
        !document.querySelector("input:focus, textarea:focus, select:focus")
      )
        await loadAdmin(state.admin?.day);
    } catch (e) {
      toast(`정보를 갱신하지 못했어요. ${e.message}`);
    }
  }, 30000);
}
async function boot() {
  try {
    if (location.pathname === "/restaurant") {
      await renderRestaurant();
      startRefresh();
      return;
    }
    const data = await api("/status");
    state.user = data.user;
    if (state.user) {
      await afterLogin();
    } else renderAuth(data.setupNeeded, data.setupAvailable);
  } catch (e) {
    root.innerHTML = `${header()}<main class="shell"><div class="empty"><h2>연결을 확인해주세요.</h2><p>${esc(e.message)}</p><button class="btn" data-action="reload">다시 불러오기</button></div></main>`;
    root.querySelector("[data-action=reload]").onclick = boot;
  }
}
boot();

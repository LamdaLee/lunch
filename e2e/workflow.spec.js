import { test, expect } from "@playwright/test";
import { fixture, testPassword } from "../test/helpers.js";
let app;
test.beforeEach(async () => {
  app = await fixture();
});
test.afterEach(async () => {
  await app.close();
});
async function login(page, name = "AX학생") {
  await page.goto(app.base);
  await page
    .getByLabel("학번 / 로그인 ID", { exact: true })
    .fill({ 테스트관리자: "admin", AX학생: "ax001" }[name] || name);
  await page.getByLabel("비밀번호", { exact: true }).fill(testPassword);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "오늘은 어디서 먹을까요?" }),
  ).toBeVisible();
}
test("모바일 로그인 → 예약 → 변경 → 취소, 화면 넘침 없이 이용", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await expect(page.locator(".today-date")).toHaveText(
    "2026년 10월 12일 월요일",
  );
  await expect(page.locator(".food-photo").first()).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".food-photo")
        .first()
        .evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await page
    .locator(".restaurant-card")
    .filter({
      has: page.getByRole("heading", { name: "한끼식당", exact: true }),
    })
    .getByRole("button", { name: "나도 여기 갈래요" })
    .click();
  await expect(page.locator(".reservation-name")).toHaveText("한끼식당");
  await page
    .locator(".restaurant-card")
    .filter({
      has: page.getByRole("heading", { name: "온기국수", exact: true }),
    })
    .getByRole("button", { name: "이 식당으로 변경" })
    .click();
  await expect(page.locator(".reservation-name")).toHaveText("온기국수");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      page
        .locator(".kkoma-photo")
        .evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await page.screenshot({
    path: ".local/screenshots/mobile-reservation.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "선택 취소", exact: true }).click();
  await expect(page.locator(".empty-reservation")).toBeVisible();
  expect(errors).toEqual([]);
});
test("게시판은 HTML을 실행하지 않고 텍스트로 표시", async ({ page }) => {
  await app.db
    .prepare("UPDATE mission_event SET active=1,start_day=\'2026-10-12\'")
    .run();
  await login(page);
  await page.getByRole("button", { name: "우리의 게시판" }).click();
  await page.getByLabel("게시글 제목").fill("오늘 같이 먹어요 <b>점심</b>");
  await page
    .getByLabel("오늘 나누고 싶은 이야기")
    .fill('<img src=x onerror="window.hacked=true"> 오늘 메뉴 추천!');
  await page.getByRole("button", { name: "게시하기" }).click();
  await expect(page.locator(".post-body")).toContainText("<img src=x");
  expect(await page.evaluate(() => Boolean(window.hacked))).toBe(false);
  await page.getByRole("button", { name: "오늘의 식당", exact: true }).click();
  await expect(page.locator(".today-post-list")).toContainText(
    "오늘 같이 먹어요 <b>점심</b>",
  );
  await expect(page.locator(".today-post-list")).not.toContainText("onerror");
  await page.locator(".today-post-title").click();
  await expect(page.locator("dialog .post-body")).toContainText("<img src=x");
  expect(await page.evaluate(() => Boolean(window.hacked))).toBe(false);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .getByRole("button", { name: "간식 쿠폰 이벤트", exact: true })
    .click();
  const mission = page.locator(".mission-card").filter({
    has: page.getByRole("heading", {
      name: "맛집 하나 추천하기",
      exact: true,
    }),
  });
  const post = await app.db
    .prepare("SELECT id FROM posts WHERE user_id=2 ORDER BY id DESC LIMIT 1")
    .get();
  await mission.locator("select").selectOption(String(post.id));
  await mission
    .getByRole("button", { name: "미션 제출하고 응모하기", exact: true })
    .click();
  await expect(mission.locator(".mission-result")).toContainText("확인 중");
});
test("운영진 계정 등록 → 첫 비밀번호 변경 → 관리 접근, 인원 링크는 조회만 가능", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "테스트관리자");
  await page.getByRole("button", { name: "운영 관리", exact: true }).click();
  await page
    .locator("tr")
    .filter({ has: page.getByText("한끼식당", { exact: true }) })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  await page
    .getByLabel("식당 소개")
    .fill("방문 예정 인원을 보고 서로 조율해요");
  await page
    .getByLabel("네이버 링크", { exact: true })
    .fill("https://naver.me/xIeXiYYf");
  await page.getByRole("button", { name: "저장하기" }).click();
  await expect(page.locator("dialog")).not.toBeVisible();
  await expect(
    page
      .locator("tr")
      .filter({ has: page.getByText("한끼식당", { exact: true }) }),
  ).toContainText("0명");
  await page
    .getByRole("combobox", { name: "권한", exact: true })
    .selectOption("admin");
  await page.getByLabel("이름", { exact: true }).fill("신규학생");
  await page.getByLabel("학번 / 로그인 ID", { exact: true }).fill("new001");
  await page.getByLabel("초기 비밀번호", { exact: true }).fill(testPassword);
  await page.getByRole("button", { name: "이용자 등록", exact: true }).click();
  await expect(page.locator(".code-output")).toContainText("new001");
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  const context = await browser.newContext();
  const member = await context.newPage();
  await member.goto(app.base);
  await member.getByLabel("학번 / 로그인 ID", { exact: true }).fill("new001");
  await member.getByLabel("비밀번호", { exact: true }).fill(testPassword);
  await member.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    member.getByRole("heading", { name: "신규학생 님, 반가워요!" }),
  ).toBeVisible();
  await member.getByLabel("초기 비밀번호", { exact: true }).fill(testPassword);
  await member
    .getByLabel("새 비밀번호", { exact: true })
    .fill("personal-new-password-14");
  await member
    .getByLabel("새 비밀번호 확인", { exact: true })
    .fill("personal-new-password-14");
  await member
    .getByRole("button", { name: "비밀번호 변경하고 시작하기" })
    .click();
  await expect(
    member.getByRole("heading", { name: "오늘은 어디서 먹을까요?" }),
  ).toBeVisible();
  await expect(
    member.getByRole("button", { name: "운영 관리", exact: true }),
  ).toBeVisible();
  await expect(
    member.locator(".restaurant-card").first().getByRole("link"),
  ).toHaveAttribute("href", "https://naver.me/xIeXiYYf");
  await expect(
    member.locator(".restaurant-card").first().getByRole("link"),
  ).toHaveAttribute("target", "_blank");
  await member
    .locator(".restaurant-card")
    .first()
    .getByRole("button", { name: "나도 여기 갈래요" })
    .click();
  await page.getByRole("button", { name: "운영 관리", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "식당 선택 명단" }),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/screenshots/admin.png",
    fullPage: true,
  });
  await page
    .locator("tr")
    .filter({ has: page.getByText("한끼식당", { exact: true }) })
    .first()
    .getByRole("button", { name: "인원 보기 링크" })
    .click();
  const link = await page.locator(".code-output").textContent();
  const restaurant = await context.newPage();
  await restaurant.goto(link);
  await expect(restaurant.locator(".count")).toHaveText("1명");
  await expect(
    restaurant.getByRole("heading", { name: "입력된 실제 식사 기록" }),
  ).toBeVisible();
  await expect(restaurant.locator(".record-count")).toHaveText("0명");
  await expect(
    restaurant.getByText("미입력자는 포함되지 않아", { exact: false }),
  ).toBeVisible();
  await expect(restaurant.getByText("신규학생", { exact: true })).toHaveCount(
    0,
  );
  await expect(restaurant).toHaveURL(/\/restaurant$/);
  // The restaurant page only edits its own people limit and menu.
  await expect(restaurant.locator("form")).toHaveCount(2);
  await expect(restaurant.locator("#restaurant-limit-form")).toBeVisible();
  await expect(restaurant.locator("#restaurant-menu-form")).toBeVisible();
  await restaurant.screenshot({
    path: ".local/screenshots/restaurant.png",
    fullPage: true,
  });
  await context.close();
});
test("실제 폰트 로딩과 데스크톱 로그인 디자인", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(app.base);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.fonts.check("16px Pretendard")),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/login-desktop.png",
    fullPage: true,
  });
  await login(page);
  await page.screenshot({
    path: ".local/screenshots/dashboard-desktop.png",
    fullPage: true,
  });
});

test("내 식사 기록과 메뉴의 비밀번호 변경 창", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.db
    .prepare(
      "INSERT INTO reservations(user_id,restaurant_id,day,created_at) VALUES (2,2,?,?)",
    )
    .run("2026-10-11", "2026-10-11T01:00:00Z");
  await login(page);
  await page.getByRole("button", { name: "내 식사 기록", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "내 식사 기록", exact: true }),
  ).toBeVisible();
  await expect(page.locator("tbody")).toContainText("2026-10-11");
  await expect(page.locator("tbody")).toContainText("온기국수");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "비밀번호 변경", exact: true })
    .click();
  await page.getByLabel("현재 비밀번호", { exact: true }).fill(testPassword);
  await page
    .getByLabel("새 비밀번호", { exact: true })
    .fill("personal-password-changed-71");
  await page
    .getByLabel("새 비밀번호 확인", { exact: true })
    .fill("different-password-71");
  await page.getByRole("button", { name: "변경하기", exact: true }).click();
  await expect(page.locator("#password-error")).toHaveText(
    "새 비밀번호가 일치하지 않습니다.",
  );
  await page
    .getByLabel("새 비밀번호 확인", { exact: true })
    .fill("personal-password-changed-71");
  await page.getByRole("button", { name: "변경하기", exact: true }).click();
  await expect(page.locator("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.getByLabel("학번 / 로그인 ID", { exact: true }).fill("ax001");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("personal-password-changed-71");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "오늘은 어디서 먹을까요?" }),
  ).toBeVisible();
});

test("앞에 0이 있는 4자리 초기 비밀번호로 로그인 후 개인 비밀번호 변경", async ({
  page,
}) => {
  const { passwordHash } = await import("../lib/store.js");
  await app.db
    .prepare("UPDATE users SET password=?,must_change=1 WHERE login_id=?")
    .run(passwordHash("0642"), "ax001");
  await page.goto(app.base);
  await page.getByLabel("학번 / 로그인 ID", { exact: true }).fill("ax001");
  await page.getByLabel("비밀번호", { exact: true }).fill("0642");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "AX학생 님, 반가워요!" }),
  ).toBeVisible();
  await page.getByLabel("초기 비밀번호", { exact: true }).fill("0642");
  await page
    .getByLabel("새 비밀번호", { exact: true })
    .fill("new-personal-password-99");
  await page
    .getByLabel("새 비밀번호 확인", { exact: true })
    .fill("new-personal-password-99");
  await page
    .getByRole("button", { name: "비밀번호 변경하고 시작하기" })
    .click();
  await expect(
    page.getByRole("heading", { name: "오늘은 어디서 먹을까요?" }),
  ).toBeVisible();
});

test("운영진 이벤트 생성·인원 수정 → 학생 응모 → 승인·지급", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "테스트관리자");
  await page.getByRole("button", { name: "운영 관리", exact: true }).click();
  await page
    .getByRole("button", { name: "+ 이벤트 만들기", exact: true })
    .click();
  await page
    .getByLabel("이벤트 이름", { exact: true })
    .fill("간식 응모 이벤트");
  await page
    .getByLabel("이벤트 소개", { exact: true })
    .fill("조건을 확인하고 신청해주세요.");
  await page.getByLabel("시작일", { exact: true }).fill("2026-10-12");
  await page.getByLabel("종료일").fill("2026-10-20");
  await page
    .getByLabel("미션 이름", { exact: true })
    .fill("참여 방법 확인하기");
  await page
    .getByRole("textbox", { name: "이벤트 조건", exact: true })
    .fill("이벤트 조건을 읽고 응모해주세요.");
  await page.getByLabel("지급 인원", { exact: true }).fill("1");
  await page.getByRole("button", { name: "이벤트 저장", exact: true }).click();
  await expect(page.locator("dialog")).not.toBeVisible();
  const adminEvent = page.locator(".admin-event").filter({
    has: page.getByRole("heading", { name: "간식 응모 이벤트", exact: true }),
  });
  await adminEvent
    .getByRole("button", { name: "접수 시작", exact: true })
    .click();
  await expect(adminEvent).toContainText("접수 상태: 열림");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const student = await context.newPage();
  await login(student);
  await student
    .getByRole("button", { name: "간식 쿠폰 이벤트", exact: true })
    .click();
  await expect(student.getByText("응모자: AX학생 · ax001")).toBeVisible();
  await student
    .getByRole("checkbox", { name: "위 이벤트 조건을 확인하고 응모합니다." })
    .check();
  await student.getByRole("button", { name: "응모하기", exact: true }).click();
  await expect(student.locator(".mission-result")).toContainText("확인 중");
  expect(
    await student.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await login(other, "sf001");
  await other
    .getByRole("button", { name: "간식 쿠폰 이벤트", exact: true })
    .click();
  await expect(
    other.getByRole("button", { name: "응모하기", exact: true }),
  ).toBeDisabled();
  await expect(other.getByText("선착순 마감", { exact: true })).toBeVisible();
  await page.locator(".notification-button").click();
  await expect(page.locator(".notification-body")).toContainText("AX학생");
  await page
    .getByRole("button", { name: "신청 확인하기 →", exact: true })
    .click();
  await expect(page.locator(".notification-count")).toBeHidden();

  await adminEvent
    .getByRole("button", { name: "보완 요청", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "보완 사유", exact: true })
    .fill("참여 내용을 한 줄 더 적어주세요.");
  await page
    .locator("dialog")
    .getByRole("button", { name: "보완 요청", exact: true })
    .click();
  await expect(page.locator("dialog")).not.toBeVisible();
  await student.locator(".notification-button").click();
  await expect(student.locator(".notification-body")).toContainText(
    "참여 내용을 한 줄 더 적어주세요.",
  );
  await student
    .getByRole("button", { name: "이벤트 확인하기 →", exact: true })
    .click();
  await student
    .getByRole("textbox", { name: /참여 내용/ })
    .fill("이벤트 조건을 확인했습니다.");
  await student
    .getByRole("checkbox", { name: "위 이벤트 조건을 확인하고 응모합니다." })
    .check();
  await student
    .getByRole("button", { name: "보완해서 다시 응모", exact: true })
    .click();
  await expect(student.locator(".mission-result")).toContainText("확인 중");
  await page.locator(".notification-button").click();
  await page
    .locator(".notification-card.unread")
    .getByRole("button", { name: "신청 확인하기 →", exact: true })
    .click();
  await adminEvent.getByRole("button", { name: "승인", exact: true }).click();
  await page
    .locator("dialog")
    .getByRole("button", { name: "승인", exact: true })
    .click();
  await expect(page.locator("dialog")).not.toBeVisible();
  await student
    .getByRole("button", { name: "간식 쿠폰 이벤트", exact: true })
    .click();
  await expect(student.locator(".coupon-code")).toContainText("LP-");
  await adminEvent
    .getByRole("button", { name: "쿠폰 지급 완료", exact: true })
    .click();
  await page
    .locator("dialog")
    .getByRole("button", { name: "지급 완료", exact: true })
    .click();
  await expect(page.locator("dialog")).not.toBeVisible();
  await student
    .getByRole("button", { name: "간식 쿠폰 이벤트", exact: true })
    .click();
  await expect(student.locator(".mission-result")).toContainText(
    "쿠폰 지급 완료",
  );
  await adminEvent
    .getByRole("button", { name: "조건·지급 인원 수정", exact: true })
    .click();
  await page.getByLabel("지급 인원", { exact: true }).fill("2");
  await page
    .getByRole("combobox", { name: "승인 방식", exact: true })
    .selectOption("no");
  await page.getByRole("button", { name: "이벤트 저장", exact: true }).click();
  await expect(page.locator("dialog")).not.toBeVisible();
  await other
    .getByRole("button", { name: "간식 쿠폰 이벤트", exact: true })
    .click();
  await other
    .getByRole("checkbox", { name: "위 이벤트 조건을 확인하고 응모합니다." })
    .check();
  await other.getByRole("button", { name: "응모하기", exact: true }).click();
  await expect(other.locator(".mission-result")).toContainText(
    "쿠폰 수령 가능",
  );
  await expect(other.locator(".coupon-code")).toContainText("LP-");
  await student.screenshot({
    path: ".local/screenshots/event-mobile.png",
    fullPage: true,
  });
  await page.screenshot({
    path: ".local/screenshots/event-admin.png",
    fullPage: true,
  });
  await context.close();
  await otherContext.close();
});

test("만석 후 식사 기록 수정과 좌석 미확보 안내", async ({ page }) => {
  await app.db
    .prepare(
      "INSERT INTO reservations(user_id,restaurant_id,day,created_at) VALUES (2,1,'2026-10-12','2026-10-12T01:00:00Z')",
    )
    .run();
  app.setTime("2026-10-12T14:00:00+09:00");
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.locator(".plan-notice")).toContainText(
    "좌석 예약이 아닌 방문 예정 공유",
  );
  await page.getByRole("button", { name: "내 식사 기록", exact: true }).click();
  await page
    .getByRole("button", { name: "실제 식당 수정", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "실제 식사한 식당", exact: true })
    .selectOption("2");
  await page
    .getByRole("button", { name: "식사 기록 저장", exact: true })
    .click();
  await expect(page.locator("dialog")).not.toBeVisible();
  await expect(page.locator("tbody")).toContainText("온기국수");
  await expect(page.locator("tbody")).toContainText("원래 예정: 한끼식당");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("식당이 메뉴 등록 → 학생이 메뉴 예약 → 식당에서 예약 명단 확인, 게시판 댓글", async ({
  page,
  browser,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const token = (
    await app.db
      .prepare("SELECT access_token FROM restaurants WHERE id=1")
      .get()
  ).access_token;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const restaurant = await context.newPage();
  restaurant.on("pageerror", (e) => errors.push(e.message));
  await restaurant.goto(`${app.base}/restaurant?token=${token}`);
  await restaurant.getByLabel("메뉴 이름").fill("제육덮밥");
  await restaurant.getByLabel("가격").fill("9000");
  await restaurant.getByRole("button", { name: "메뉴 추가" }).click();
  await expect(restaurant.locator(".menu-items")).toContainText("제육덮밥");
  await restaurant.getByLabel("메뉴 이름").fill("김치찌개");
  await restaurant.getByRole("button", { name: "메뉴 추가" }).click();
  await expect(restaurant.locator(".menu-items li")).toHaveCount(2);
  await restaurant.getByRole("button", { name: "김치찌개 수정" }).click();
  await restaurant.locator("#menu-edit-form [name=name]").fill("김치찌개 정식");
  await restaurant.locator("#menu-edit-form [name=price]").fill("8500");
  await restaurant.getByRole("button", { name: "저장하기" }).click();
  await expect(restaurant.locator(".menu-items")).toContainText(
    "김치찌개 정식 8,500원",
  );
  await restaurant.getByRole("button", { name: "김치찌개 정식 수정" }).click();
  await restaurant.locator("#menu-edit-form [name=name]").fill("김치찌개");
  await restaurant.locator("#menu-edit-form [name=price]").fill("");
  await restaurant.getByRole("button", { name: "저장하기" }).click();
  await expect(
    restaurant.getByRole("button", { name: "김치찌개 수정" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const card = page
    .locator(".restaurant-card")
    .filter({ has: page.getByRole("heading", { name: "한끼식당" }) });
  await card.getByRole("button", { name: "나도 여기 갈래요" }).click();
  await expect(page.locator("#toast")).toHaveText(
    "예약할 메뉴를 먼저 골라주세요.",
  );
  await card.getByLabel("예약할 메뉴").selectOption({ label: "제육덮밥 · 9,000원" });
  await card.getByRole("button", { name: "나도 여기 갈래요" }).click();
  await expect(page.locator(".reservation-summary")).toContainText(
    "제육덮밥 · 9,000원",
  );
  await card.getByLabel("예약할 메뉴").selectOption({ label: "김치찌개" });
  await card.getByRole("button", { name: "예약 변경 저장" }).click();
  await expect(page.locator(".reservation-summary")).toContainText("김치찌개");
  await card.getByRole("button", { name: "한끼식당 선택 취소" }).click();
  await expect(page.locator(".reservation-summary")).toContainText(
    "아직 선택한 식당이 없어요.",
  );
  await expect(card.locator(".card-cancel")).toHaveCount(0);
  await card.getByLabel("예약할 메뉴").selectOption({ label: "김치찌개" });
  await card.getByRole("button", { name: "나도 여기 갈래요" }).click();
  await expect(card.locator(".card-cancel")).toBeVisible();
  // Typed menus for restaurants with many dishes.
  await expect(card.locator(".menu-note")).toBeHidden();
  await card.getByLabel("예약할 메뉴").selectOption({ label: "직접 입력" });
  await card.getByLabel("메뉴 직접 적기").fill("제육 곱빼기, 계란후라이 추가");
  await card.getByRole("button", { name: "예약 변경 저장" }).click();
  await expect(page.locator(".reservation-summary")).toContainText(
    "제육 곱빼기, 계란후라이 추가",
  );
  await expect(card.getByLabel("메뉴 직접 적기")).toHaveValue(
    "제육 곱빼기, 계란후라이 추가",
  );
  await card.getByLabel("식당에 전할 요청사항").fill("3명 같이 가요. 계란 빼주세요");
  await card.getByRole("button", { name: "요청사항 저장" }).click();
  await expect(page.locator(".reservation-summary")).toContainText(
    "3명 같이 가요. 계란 빼주세요",
  );
  await page.screenshot({
    path: ".local/screenshots/custom-menu-card.png",
    fullPage: false,
  });

  await restaurant.getByRole("button", { name: "↻ 새로고침" }).click();
  const orders = restaurant.locator(".restaurant-orders");
  await expect(orders).toContainText("AX학생");
  await expect(orders).toContainText("제육 곱빼기, 계란후라이 추가");
  await expect(orders).toContainText("직접 입력");
  await expect(orders.locator(".order-request")).toContainText(
    "3명 같이 가요. 계란 빼주세요",
  );
  await expect(orders).not.toContainText("ax001");
  expect(
    await restaurant.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await restaurant.getByLabel("최대 인원").fill("1");
  await restaurant.getByRole("button", { name: "인원 제한 저장" }).click();
  await expect(restaurant.locator(".limit-now")).toContainText("최대 1명");
  await expect(restaurant.locator(".count")).toContainText("1명 / 1명");
  await page.getByRole("button", { name: "오늘의 식당" }).click();
  await expect(card.locator(".capacity")).toContainText("/ 최대 1명");
  await restaurant.screenshot({
    path: ".local/screenshots/restaurant-orders.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "우리의 게시판" }).click();
  await page.getByLabel("게시글 제목").fill("같이 가요");
  await page.locator("#post-body").fill("한끼식당 12:50");
  await page.getByRole("button", { name: "게시하기 ↗" }).click();
  const post = page.locator(".post").first();
  await post.getByPlaceholder("댓글을 남겨주세요").fill("<b>좋아요</b>");
  await post.getByRole("button", { name: "등록" }).click();
  await expect(page.locator(".comment-body")).toHaveText("<b>좋아요</b>");
  await expect(page.locator(".comments h4")).toContainText("1");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/board-comments.png",
    fullPage: true,
  });
  await page.locator(".comment").getByRole("button", { name: "댓글 삭제" }).click();
  await page.locator("#confirm-yes").click();
  await expect(page.locator(".comment")).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("오늘의 채팅: 다른 사람 메시지가 몇 초 안에 보이고 삭제도 반영", async ({
  page,
  browser,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const other = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  other.on("pageerror", (e) => errors.push(e.message));
  await other.goto(app.base);
  await other.getByLabel("학번 / 로그인 ID", { exact: true }).fill("sf001");
  await other.getByLabel("비밀번호", { exact: true }).fill(testPassword);
  await other.getByRole("button", { name: "로그인", exact: true }).click();

  // The chat sits between the page heading and the snack coupon banner.
  const order = await page.evaluate(() => {
    const top = (selector) =>
      document.querySelector(selector).getBoundingClientRect().top;
    return [top(".hero h1"), top("#chat-panel"), top(".mission-banner")];
  });
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);

  await page.getByLabel("메시지 입력").fill("12:50에 파스토보이 가실 분?");
  await page.getByRole("button", { name: "보내기" }).click();
  await expect(page.locator(".chat-message.mine")).toContainText(
    "12:50에 파스토보이 가실 분?",
  );
  await expect(other.locator(".chat-message")).toContainText(
    "12:50에 파스토보이 가실 분?",
    { timeout: 8000 },
  );
  await other.getByLabel("메시지 입력").fill("저요! <b>같이</b> 가요");
  await other.getByLabel("메시지 입력").press("Enter");
  await expect(page.locator(".chat-message").nth(1)).toHaveText(
    /저요! <b>같이<\/b> 가요/,
    { timeout: 8000 },
  );
  await expect(
    other.locator(".chat-message").first().getByRole("button", { name: "메시지 삭제" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.locator("#chat-panel").screenshot({
    path: ".local/screenshots/chat.png",
  });

  await page
    .locator(".chat-message.mine")
    .getByRole("button", { name: "메시지 삭제" })
    .click();
  await page.locator("#confirm-yes").click();
  await expect(page.locator(".chat-message")).toHaveCount(1);
  await expect(other.locator(".chat-message")).toHaveCount(1, {
    timeout: 8000,
  });
  expect(errors).toEqual([]);
  await other.close();
});

test("같은 식당을 고른 사람과 일행으로 묶으면 식당 화면에 일행별로 표시", async ({
  page,
  browser,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const token = (
    await app.db
      .prepare("SELECT access_token FROM restaurants WHERE id=1")
      .get()
  ).access_token;
  const sf = await app.login("SF학생");
  await app.request("/choice", {
    method: "POST",
    cookie: sf,
    body: { restaurantId: 1 },
  });
  const staff = await app.login("테스트강사");
  await app.request("/choice", {
    method: "POST",
    cookie: staff,
    body: { restaurantId: 1 },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const card = page
    .locator(".restaurant-card")
    .filter({ has: page.getByRole("heading", { name: "한끼식당" }) });
  await card.getByRole("button", { name: "나도 여기 갈래요" }).click();
  const box = card.locator(".party-box");
  await expect(box).toContainText("SF학생");
  await box.getByLabel("SF학생").check();
  await box.getByRole("button", { name: "일행으로 묶기" }).click();
  await expect(box.locator(".party-now")).toContainText("SF학생");
  await expect(box.locator(".party-now")).toContainText("나 포함 2명");
  await expect(page.locator(".reservation-summary")).toContainText("나 포함 2명");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await card.screenshot({ path: ".local/screenshots/party-card.png" });

  const restaurant = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  await restaurant.goto(`${app.base}/restaurant?token=${token}`);
  const orders = restaurant.locator(".restaurant-orders");
  await expect(orders.locator(".party-summary")).toContainText("일행 1팀");
  await expect(orders.locator(".party-summary")).toContainText("혼자 1명");
  const group = orders.locator(".party-group").first();
  await expect(group).toContainText("일행 1");
  await expect(group).toContainText("AX학생");
  await expect(group).toContainText("SF학생");
  await expect(orders.locator(".party-group.solo")).toContainText(
    "메뉴·요청 없이 혼자 오는 손님 1명",
  );
  await orders.screenshot({ path: ".local/screenshots/party-orders.png" });

  await box.getByRole("button", { name: "일행에서 나가기" }).click();
  await expect(box.locator(".party-now")).toHaveCount(0);
  expect(errors).toEqual([]);
  await restaurant.close();
});

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
  await page.screenshot({
    path: ".local/screenshots/mobile-reservation.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "선택 취소", exact: true }).click();
  await expect(page.locator(".empty-reservation")).toBeVisible();
  expect(errors).toEqual([]);
});
test("게시판은 HTML을 실행하지 않고 텍스트로 표시", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "우리의 게시판" }).click();
  await page
    .getByLabel("오늘 나누고 싶은 이야기")
    .fill('<img src=x onerror="window.hacked=true"> 오늘 메뉴 추천!');
  await page.getByRole("button", { name: "게시하기" }).click();
  await expect(page.locator(".post-body")).toContainText("<img src=x");
  expect(await page.evaluate(() => Boolean(window.hacked))).toBe(false);
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
  await page.getByRole("button", { name: "저장하기" }).click();
  await expect(page.locator("dialog")).not.toBeVisible();
  await expect(
    page
      .locator("tr")
      .filter({ has: page.getByText("한끼식당", { exact: true }) }),
  ).toContainText("0명");
  await page.getByRole("combobox", { name: "권한", exact: true }).selectOption("admin");
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
  await expect(restaurant.getByText("신규학생", { exact: true })).toHaveCount(
    0,
  );
  await expect(restaurant).toHaveURL(/\/restaurant$/);
  await expect(restaurant.locator("form")).toHaveCount(0);
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

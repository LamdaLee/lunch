import { createInterface } from "node:readline/promises";
import { openStore, createAdmin } from "./lib/store.js";
const db = openStore();
await db.ready;
if (await db.prepare("SELECT id FROM users WHERE role='admin'").get()) {
  console.log("관리자 계정이 이미 있습니다. npm start로 실행하세요.");
  await db.close();
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const name =
      (await rl.question("관리자 로그인 이름 (기본: 운영관리자): ")).trim() ||
      "운영관리자";
    const loginId =
      (await rl.question("관리자 로그인 ID (기본: admin): ")).trim() || "admin";
    // Hide terminal echo while reading the password; never save a plaintext password.
    const readPassword = async (prompt) => {
      if (!process.stdin.isTTY) return rl.question(prompt);
      process.stdout.write(prompt);
      rl.pause();
      process.stdin.setRawMode(true);
      process.stdin.resume();
      return new Promise((resolve) => {
        let value = "";
        const onData = (chunk) => {
          for (const char of chunk.toString()) {
            if (char === "\u0003") {
              process.exit(130);
            }
            if (char === "\r" || char === "\n") {
              process.stdin.off("data", onData);
              process.stdin.setRawMode(false);
              process.stdout.write("\n");
              rl.resume();
              resolve(value);
              return;
            }
            if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
            else if (char >= " ") value += char;
          }
        };
        process.stdin.on("data", onData);
      });
    };
    const password = await readPassword("비밀번호 (8자 이상, 입력 숨김): ");
    const confirm = await readPassword("비밀번호 확인: ");
    if (password !== confirm) throw new Error("비밀번호가 일치하지 않습니다.");
    await createAdmin(db, name, password, loginId);
    console.log(
      "관리자 생성 완료. npm start로 실행하고 식당 이름·정원을 설정하세요.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    rl.close();
    await db.close();
  }
}

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { openStore, createAdmin } from "./lib/store.js";
const db = openStore();
await db.ready;
if (await db.prepare("SELECT id FROM users WHERE role='admin'").get()) {
  console.log("관리자 계정이 이미 있습니다. npm start로 실행하세요.");
  await db.close();
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let passwordReader = rl;
  try {
    const name =
      (await rl.question("관리자 로그인 이름 (기본: 운영관리자): ")).trim() ||
      "운영관리자";
    const loginId =
      (await rl.question("관리자 로그인 ID (기본: admin): ")).trim() || "admin";
    // Use a separate silent terminal reader so neither readline nor the TTY echoes passwords.
    if (process.stdin.isTTY) {
      rl.close();
      const silentOutput = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
      passwordReader = createInterface({
        input: process.stdin,
        output: silentOutput,
        terminal: true,
      });
      passwordReader.on("SIGINT", () => {
        passwordReader.close();
        process.exit(130);
      });
    }
    const readPassword = async (prompt) => {
      process.stdout.write(prompt);
      const value = await passwordReader.question("");
      process.stdout.write("\n");
      return value;
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
    passwordReader.close();
    rl.close();
    await db.close();
  }
}

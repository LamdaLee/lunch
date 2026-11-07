// 대전 훈련생 포털(별도 앱)과의 연결. 로그인 화면은 포털이 기본이고, 계정은 런치패스에 있습니다.
// - 포털 서버가 학번·비밀번호 확인, 첫 비밀번호 변경, 명단 조회를 서명된 요청으로 부릅니다.
// - 포털의 점심 탭은 1회용 서명 토큰(/api/portal/enter)으로 런치패스에 자동 로그인합니다.
// 두 앱은 PORTAL_SECRET 으로 서명한 짧은 토큰과 요청만 주고받고, DB 는 공유하지 않습니다.
// 같은 코드가 포털 저장소의 lib/lunchpass.js 에도 있습니다. 바꿀 때는 둘 다 바꿔 주세요.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const b64 = (value) => Buffer.from(value).toString("base64url");
const mac = (secret, text) =>
  createHmac("sha256", secret).update(text).digest();

export function portalConfig(env = process.env) {
  const secret = env.PORTAL_SECRET || "";
  if (!env.PORTAL_URL || secret.length < 32) return null;
  try {
    const url = new URL(env.PORTAL_URL);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    return { url: url.origin, secret };
  } catch {
    return null;
  }
}

export function signToken(secret, purpose, payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(secret, `${purpose}.${body}`))}`;
}

export function verifyToken(secret, purpose, token, nowMs) {
  const [body, sig, extra] = String(token || "").split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = mac(secret, `${purpose}.${body}`);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < nowMs)
    return null;
  return payload;
}

// 서버끼리 부르는 요청: 메서드·경로·시각·본문에 서명합니다(±5분).
export function requestSignature(secret, method, path, ts, body = "") {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return b64(mac(secret, `req.${method}.${path}.${ts}.${bodyHash}`));
}

export function verifyRequest(secret, method, path, headers, nowMs, body = "") {
  const ts = Number(headers["x-portal-ts"]);
  const sig = String(headers["x-portal-signature"] || "");
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > 5 * 60_000) return false;
  const expected = Buffer.from(
    requestSignature(secret, method, path, ts, body),
  );
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

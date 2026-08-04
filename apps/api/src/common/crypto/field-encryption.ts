// 건강 민감필드(body_fat_pct, pain_score, session_feedback.pain) 앱 레벨 암호화.
// 저장 형식: "v1:iv:tag:ciphertext" (iv 12B / tag 16B / ciphertext, 각각 base64).
// 평문·암호문·키는 에러 메시지나 로그에 절대 넣지 않는다(SECURITY_PIPA.md).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// 키는 호출 시점에 읽는다(모듈 로드 시점 X): 테스트/런타임 환경 주입 순서에 의존하지 않기 위해.
function loadKey(): Buffer {
  const encoded = process.env.FIELD_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error("FIELD_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`FIELD_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptField(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4) {
    throw new Error("encrypted field has invalid format");
  }
  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (version !== VERSION) {
    throw new Error(`encrypted field has unsupported version, expected ${VERSION}`);
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("encrypted field has invalid format");
  }

  const decipher = createDecipheriv(ALGORITHM, loadKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM 인증 실패 = 키 불일치 또는 변조. 원인 상세(암호문 등)는 노출하지 않는다.
    throw new Error("encrypted field failed authentication");
  }
}

export function encryptNumber(value: number | null): string | null {
  return value === null ? null : encryptField(String(value));
}

export function decryptNumber(stored: string | null): number | null {
  if (stored === null) {
    return null;
  }
  const value = Number(decryptField(stored));
  if (!Number.isFinite(value)) {
    throw new Error("decrypted field is not a number");
  }
  return value;
}

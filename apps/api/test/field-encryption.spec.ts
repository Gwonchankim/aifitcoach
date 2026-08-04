import { randomBytes } from "node:crypto";
import {
  decryptField,
  decryptNumber,
  encryptField,
  encryptNumber,
} from "../src/common/crypto/field-encryption";

const originalKey = process.env.FIELD_ENCRYPTION_KEY;

function newKey(): string {
  return randomBytes(32).toString("base64");
}

function setKey(key: string | undefined): void {
  if (key === undefined) {
    delete process.env.FIELD_ENCRYPTION_KEY;
  } else {
    process.env.FIELD_ENCRYPTION_KEY = key;
  }
}

// 파일 .env에 의존하지 않도록 테스트 안에서 키를 생성·주입하고 끝나면 원복한다.
beforeEach(() => setKey(newKey()));
afterAll(() => setKey(originalKey));

describe("field-encryption 왕복", () => {
  it("암호화 → 복호화 = 원본", () => {
    const plaintext = "18.4";
    expect(decryptField(encryptField(plaintext))).toBe(plaintext);
  });

  it("저장 형식은 v1:iv:tag:ciphertext (iv 12B, tag 16B, base64)", () => {
    const parts = encryptField("7").split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1], "base64")).toHaveLength(12);
    expect(Buffer.from(parts[2], "base64")).toHaveLength(16);
  });

  it("숫자 헬퍼: 정수·소수·null 왕복", () => {
    expect(decryptNumber(encryptNumber(7))).toBe(7);
    expect(decryptNumber(encryptNumber(18.4))).toBe(18.4);
    expect(decryptNumber(encryptNumber(0))).toBe(0);
    expect(encryptNumber(null)).toBeNull();
    expect(decryptNumber(null)).toBeNull();
  });
});

describe("field-encryption 비결정성", () => {
  it("같은 평문을 두 번 암호화하면 결과가 다르지만 둘 다 같은 평문으로 복호화된다", () => {
    const plaintext = "5";
    const a = encryptField(plaintext);
    const b = encryptField(plaintext);
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe(plaintext);
    expect(decryptField(b)).toBe(plaintext);
  });
});

describe("field-encryption 변조·키 불일치 탐지", () => {
  function flipByte(stored: string, partIndex: number): string {
    const parts = stored.split(":");
    const bytes = Buffer.from(parts[partIndex], "base64");
    bytes[0] ^= 0x01;
    parts[partIndex] = bytes.toString("base64");
    return parts.join(":");
  }

  it("ciphertext 1바이트 변조 시 복호화가 실패한다", () => {
    const stored = encryptField("18.4");
    expect(() => decryptField(flipByte(stored, 3))).toThrow(/authentication/);
  });

  it("tag 1바이트 변조 시 복호화가 실패한다", () => {
    const stored = encryptField("18.4");
    expect(() => decryptField(flipByte(stored, 2))).toThrow(/authentication/);
  });

  it("iv 1바이트 변조 시 복호화가 실패한다", () => {
    const stored = encryptField("18.4");
    expect(() => decryptField(flipByte(stored, 1))).toThrow(/authentication/);
  });

  it("다른 키로는 복호화가 실패한다", () => {
    const stored = encryptField("18.4");
    setKey(newKey());
    expect(() => decryptField(stored)).toThrow(/authentication/);
  });
});

describe("field-encryption 형식 검증", () => {
  it("파트 수가 4가 아니면 실패한다", () => {
    expect(() => decryptField("not-encrypted")).toThrow(/invalid format/);
    expect(() => decryptField("v1:aaa:bbb")).toThrow(/invalid format/);
    expect(() => decryptField(`${encryptField("1")}:extra`)).toThrow(/invalid format/);
  });

  it("v1 접두사가 아니면 실패한다", () => {
    const parts = encryptField("1").split(":");
    parts[0] = "v2";
    expect(() => decryptField(parts.join(":"))).toThrow(/unsupported version/);
  });

  it("iv·tag 길이가 다르면 실패한다", () => {
    const parts = encryptField("1").split(":");
    parts[1] = Buffer.alloc(8).toString("base64");
    expect(() => decryptField(parts.join(":"))).toThrow(/invalid format/);
  });
});

describe("field-encryption 키 검증", () => {
  it("키가 없으면 명확히 실패한다", () => {
    const stored = encryptField("1");
    setKey(undefined);
    expect(() => encryptField("1")).toThrow(/FIELD_ENCRYPTION_KEY is not set/);
    expect(() => decryptField(stored)).toThrow(/FIELD_ENCRYPTION_KEY is not set/);
  });

  it("키가 32바이트로 디코딩되지 않으면 명확히 실패한다", () => {
    const stored = encryptField("1");
    setKey(randomBytes(16).toString("base64"));
    expect(() => encryptField("1")).toThrow(/must decode to 32 bytes, got 16/);
    expect(() => decryptField(stored)).toThrow(/must decode to 32 bytes, got 16/);
  });
});

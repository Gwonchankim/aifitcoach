import { describe, expect, it } from "vitest";
import {
  ASSISTANCE_PROVENANCE,
  PAIN_FAILURE_CODES,
  assistanceAuditKey,
  classifyAssistanceRow,
  provenanceFor,
} from "../src/assistance";

/**
 * F-0 audit / remediation contract (V2-F 티켓 substep 1).
 * 여기는 **순수 분류 규칙**만 검증한다 — DB·Prisma 는 F-3 티켓 소유다.
 */

describe("F-0 어시스트 행 분류", () => {
  it("server-applied performed fact 가 없으면 unperformed_remediation 이다", () => {
    expect(classifyAssistanceRow({ hasServerAppliedPerformedFact: false })).toBe(
      "unperformed_remediation",
    );
  });

  it("server-applied performed fact 가 있으면 legacy_performed 다", () => {
    expect(classifyAssistanceRow({ hasServerAppliedPerformedFact: true })).toBe("legacy_performed");
  });

  it("로컬 pending outbox 는 아직 server-applied 가 아니므로 remediation 대상이다", () => {
    // 서버가 적용하기 전에 legacy_performed 로 굳으면 draft·outbox 가 있는 행을 영영 못 고친다.
    expect(
      classifyAssistanceRow({ hasServerAppliedPerformedFact: false, hasPendingLocalOutbox: true }),
    ).toBe("unperformed_remediation");
  });
});

describe("F-0 provenance", () => {
  it("enum 은 정확히 3값이다", () => {
    expect([...ASSISTANCE_PROVENANCE]).toEqual(["native", "remediated", "legacy_performed"]);
  });

  it("assistance-capable 버전의 신규 생성은 native 다", () => {
    expect(provenanceFor({ rulesVersion: "2026.08.2", hasServerAppliedPerformedFact: false })).toBe(
      "native",
    );
    expect(provenanceFor({ rulesVersion: "2026.09.0", hasServerAppliedPerformedFact: false })).toBe(
      "native",
    );
  });

  it("미수행 2026.08.1 은 remediated 다", () => {
    expect(provenanceFor({ rulesVersion: "2026.08.1", hasServerAppliedPerformedFact: false })).toBe(
      "remediated",
    );
  });

  it("수행된 2026.08.1 은 legacy_performed 다", () => {
    expect(provenanceFor({ rulesVersion: "2026.08.1", hasServerAppliedPerformedFact: true })).toBe(
      "legacy_performed",
    );
  });
});

describe("F-0 audit idempotency", () => {
  it("키는 (performed_set_id, failure_code) 다", () => {
    expect(assistanceAuditKey("ps_1", "decrypt_failed")).toBe("ps_1:decrypt_failed");
  });

  it("같은 입력은 같은 키를 준다 — 재실행해도 중복 행이 쌓이지 않는다", () => {
    expect(assistanceAuditKey("ps_1", "auth_failed")).toBe(
      assistanceAuditKey("ps_1", "auth_failed"),
    );
  });

  it("failure code 가 다르면 키가 다르다", () => {
    expect(assistanceAuditKey("ps_1", "decrypt_failed")).not.toBe(
      assistanceAuditKey("ps_1", "auth_failed"),
    );
  });

  it("failure code 는 정확히 3값이다", () => {
    expect([...PAIN_FAILURE_CODES]).toEqual(["decrypt_failed", "auth_failed", "nonnumeric"]);
  });
});

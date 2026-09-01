/**
 * 어시스트 종목의 **행 분류·provenance·audit 계약**(F-0).
 * 순수 규칙만 둔다 — Prisma 스키마·migration·실제 audit 기록은 F-3 티켓 소유다.
 *
 * 여기 규칙이 서버 predicate 와 Dexie scan 양쪽의 원천이다. 하나로 뭉치면
 * **이미 수행된 legacy 행까지 assistance-capable 버전을 요구**하게 되어 영원히 unsafe 가 된다.
 */

import {
  RULES_BUNDLE_V1,
  RULES_BUNDLE_V1_ASSIST,
  RULES_BUNDLE_V2,
  RULES_BUNDLE_V2_SPLIT,
  resolveRulesBundle,
  supportsAssistance,
  type RulesBundle,
} from "./rules-version";

/** 저장되는 provenance. 값이 바뀌면 과거 행을 어느 규칙으로 읽어야 할지 알 수 없게 된다. */
export const ASSISTANCE_PROVENANCE = ["native", "remediated", "legacy_performed"] as const;
export type AssistanceProvenance = (typeof ASSISTANCE_PROVENANCE)[number];

/** pain 복호화·파싱 실패 코드. audit 키의 일부라 문자열이 계약이다. */
export const PAIN_FAILURE_CODES = ["decrypt_failed", "auth_failed", "nonnumeric"] as const;
export type PainFailureCode = (typeof PAIN_FAILURE_CODES)[number];

/** 처방을 고쳐도 되는 행인지, 이미 수행돼 사실로 굳은 행인지. */
export type AssistanceRowClass = "unperformed_remediation" | "legacy_performed";

/**
 * 분류 기준은 **server-applied performed fact 유무 하나**다.
 * 로컬 pending outbox 는 아직 서버에 적용된 것이 아니므로 remediation 대상으로 남는다
 * (그래야 draft·outbox·plannedSetId 를 보존한 채 처방만 고칠 수 있다).
 */
export function classifyAssistanceRow(row: {
  hasServerAppliedPerformedFact: boolean;
  hasPendingLocalOutbox?: boolean;
}): AssistanceRowClass {
  return row.hasServerAppliedPerformedFact ? "legacy_performed" : "unperformed_remediation";
}

/**
 * 저장할 provenance. assistance-capable 버전에서 새로 만든 행만 native 이고,
 * legacy(`2026.08.1`) 는 수행 여부로 갈린다.
 */
export function provenanceFor(row: {
  rulesVersion: string;
  hasServerAppliedPerformedFact: boolean;
}): AssistanceProvenance {
  if (supportsAssistance(row.rulesVersion)) return "native";
  return classifyAssistanceRow(row) === "legacy_performed" ? "legacy_performed" : "remediated";
}

/**
 * provenance 별로 허용되는 rules bundle. **DB CHECK `ck_planned_assistance_version_matrix` 와
 * 같은 집합이어야 한다** — 한쪽만 넓으면 그쪽이 우회 경로가 된다.
 *
 * `native` 만 여러 버전을 갖는다: assistance 를 아는 bundle 에서 만들어진 행이라는 뜻이고,
 * pointer 가 `.09` 로 올라가면 그 버전으로도 새 행이 생긴다.
 * `remediated` 는 hotfix 가 만든 행이라 `.08.2` 하나, `legacy_performed` 는 `.08.1` 시절의
 * 사실이라 `.08.1` 하나뿐이다.
 */
export const ASSISTANCE_PROVENANCE_VERSIONS: Readonly<
  Record<AssistanceProvenance, readonly RulesBundle[]>
> = {
  native: [RULES_BUNDLE_V1_ASSIST, RULES_BUNDLE_V2, RULES_BUNDLE_V2_SPLIT],
  remediated: [RULES_BUNDLE_V1_ASSIST],
  legacy_performed: [RULES_BUNDLE_V1],
};

/**
 * provenance ↔ rules_version 조합이 허용되는가. **unknown 버전은 fail closed** —
 * `resolveRulesBundle` 이 계산 전에 throw 한다(조용히 V1 로 떨어뜨리지 않는다).
 */
export function isAllowedAssistanceVersion(
  provenance: AssistanceProvenance,
  rulesVersion: string,
): boolean {
  return ASSISTANCE_PROVENANCE_VERSIONS[provenance].includes(resolveRulesBundle(rulesVersion));
}

/**
 * audit idempotency 키 — `(performed_set_id, failure_code)`.
 * 재실행해도 중복 행이 쌓이지 않게 하는 것이 목적이라 **값 자체를 키에 넣지 않는다**
 * (ciphertext·평문 통증 값은 audit 에도 로그에도 남기지 않는다).
 */
export function assistanceAuditKey(performedSetId: string, failureCode: PainFailureCode): string {
  return `${performedSetId}:${failureCode}`;
}

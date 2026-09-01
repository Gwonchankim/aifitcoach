/**
 * `isAssistanceSafeSession` — **서버와 오프라인 미러가 같은 규칙**으로 세션 payload 를 판정한다(F-4a).
 *
 * 왜 하나로 뭉치면 안 되는가: 규칙 하나로 "assistance-capable bundle 을 요구"하면
 * **이미 수행된 legacy `.08.1` 행까지 `.08.2` 를 요구**하게 되어 그 세션은 **영원히 unsafe** 가 된다.
 * 수행 기록은 사실이라 버전을 올릴 수 없다. 그래서 분기가 둘이다.
 *
 * 클라이언트는 이 판정을 통과한 뒤에만 mirror 를 쓰고 remediation marker 를 지운다 —
 * `GET` 200 만으로 지우면 rolling deploy 중 구버전 서버의 legacy 처방이 그대로 남는다.
 *
 * **표시 게이트(D-39)와 안전 판정은 다른 축이다.** 서버는 게이트를 적용하기 **전의 raw 행**으로
 * 판정한다 — 게이트가 값을 가렸다고 그 행이 안전해지지 않는다. 가려진 legacy 처방은 게이트가
 * 열리는 순간 그대로 드러난다. 그래서 "전부 null 이면 safe" 같은 지름길을 두지 않는다.
 */

import type { AssistanceProvenance } from "./assistance";
import { supportsAssistance } from "./rules-version";
import type { LoadKind, LoadSemantics, RecommendationState, RecommendedAction } from "./types";

/** 처방을 고쳐도 되는 행인지, 이미 수행돼 사실로 굳은 행인지. */
export type AssistanceRowClassification = "unperformed_remediation" | "legacy_performed";

/** 세션 payload 한 행에서 판정에 필요한 것만. UI 표시값은 보지 않는다. */
export interface AssistanceSessionRow {
  /** 생성 시점에 굳은 immutable snapshot. 카탈로그의 현재 값이 아니다. */
  load_semantics: LoadSemantics;
  load_kind: LoadKind | null;
  assistance_provenance: AssistanceProvenance | null;
  rules_version: string;
  recommendation_state: RecommendationState | null;
  reason_code: string | null;
  recommended_weight: number | null;
  recommended_action?: RecommendedAction | null;
  /** **서버에 적용된** 수행 사실. 로컬 pending outbox 는 여기 포함하지 않는다. */
  has_server_applied_performed_fact: boolean;
}

export interface AssistanceSafetyVerdict {
  safe: boolean;
  /** unsafe 인 이유. 어느 규칙이 걸렸는지 fixture 가 지목할 수 있어야 한다. */
  reasons: string[];
}

/**
 * generic 가중 진행 reason. 어시스트 행에 이게 보이면 **구버전 서버의 처방**이다 —
 * 숫자가 "덜어주는 kg" 인데 문구는 "증량"이라 방향이 정반대가 된다.
 */
const GENERIC_WEIGHTED_REASONS = new Set([
  "WEIGHT_UP_REP_TARGET_MET",
  "RIR_TOO_EASY_INCREASE",
  "RIR_TOO_HARD_REDUCE",
  "TOO_HARD",
  "LOAD_CALIBRATION_NEEDED",
  "BASELINE",
]);

/** 어시스트 진행 reason + 어느 축에도 속하지 않는 중립 코드. */
const ASSISTANCE_READY_REASONS = new Set([
  "ASSISTANCE_DOWN_REP_TARGET_MET",
  "ASSISTANCE_DOWN_RIR_EASY",
  "ASSISTANCE_UP_RIR_HARD",
  "ASSISTANCE_UP_TOO_HARD",
  "ASSISTANCE_MINIMUM_REACHED",
  "ADD_ONE_REP",
  "HOLD_RIR_LOW",
]);

/** 분류 기준은 **server-applied performed fact 유무 하나**다. */
export function classifySessionRow(row: AssistanceSessionRow): AssistanceRowClassification {
  return row.has_server_applied_performed_fact ? "legacy_performed" : "unperformed_remediation";
}

/** snapshot 이 어시스트인가. 카탈로그가 아니라 저장된 값으로 본다. */
export function isAssistanceRow(row: AssistanceSessionRow): boolean {
  return row.load_semantics === "assistance";
}

/**
 * §F safety matrix. 두 안전 상태에서는 무게·action 이 반드시 null 이고
 * 어시스트/generic 진행 reason 을 쓰지 않는다.
 */
function checkSafetyState(row: AssistanceSessionRow, label: string, reasons: string[]): boolean {
  if (row.recommendation_state === "substitution_required") {
    if (row.reason_code !== "SUBSTITUTE_PAIN")
      reasons.push(`${label}: 통증 상태의 reason 이 다르다`);
    if (row.recommended_weight !== null) reasons.push(`${label}: 통증 상태인데 무게가 있다`);
    if (row.recommended_action != null) reasons.push(`${label}: 통증 상태인데 action 이 있다`);
    return true;
  }
  if (row.recommendation_state === "unavailable") {
    if (row.reason_code !== "INVALID_INPUT")
      reasons.push(`${label}: 입력 오류 상태의 reason 이 다르다`);
    if (row.recommended_weight !== null) reasons.push(`${label}: 입력 오류 상태인데 무게가 있다`);
    if (row.recommended_action != null) reasons.push(`${label}: 입력 오류 상태인데 action 이 있다`);
    return true;
  }
  return false;
}

function checkUnperformed(row: AssistanceSessionRow, reasons: string[]): void {
  const label = "미수행";
  if (row.load_kind !== "assistance") reasons.push(`${label}: load_kind 가 assistance 가 아니다`);
  // 미시작 `.08.1` 은 remediation 대상이다 — `.08.2` 로 올라와 있어야 한다.
  let capable = false;
  try {
    capable = supportsAssistance(row.rules_version);
  } catch {
    reasons.push(`${label}: 지원하지 않는 rules_version`);
    return;
  }
  if (!capable) reasons.push(`${label}: assistance 를 모르는 bundle 이다`);
  if (row.assistance_provenance === null) reasons.push(`${label}: provenance 가 없다`);

  if (checkSafetyState(row, label, reasons)) return;

  if (GENERIC_WEIGHTED_REASONS.has(row.reason_code ?? "")) {
    reasons.push(`${label}: generic 가중 reason 이다`);
    return;
  }
  if (row.recommendation_state === "load_calibration_needed") {
    if (row.recommended_weight !== null) reasons.push(`${label}: 캘리브레이션인데 무게가 있다`);
    if (row.reason_code !== "ASSISTANCE_CALIBRATION_NEEDED")
      reasons.push(`${label}: 캘리브레이션 reason 이 아니다`);
    return;
  }
  if (row.recommendation_state === "ready") {
    if (!(typeof row.recommended_weight === "number" && row.recommended_weight > 0))
      reasons.push(`${label}: ready 인데 양수 도움값이 아니다`);
    if (!ASSISTANCE_READY_REASONS.has(row.reason_code ?? ""))
      reasons.push(`${label}: ready 인데 어시스트 reason 이 아니다`);
    return;
  }
  reasons.push(`${label}: recommendation_state 가 없다`);
}

/**
 * 이미 수행된 `.08.1` 행. **`supportsAssistance` 를 요구하지 않는다** — 그 시절의 사실이다.
 * 대신 immutable snapshot·provenance 와 assistance 인지 렌더링만 요구한다.
 */
function checkLegacyPerformed(row: AssistanceSessionRow, reasons: string[]): void {
  const label = "수행됨";
  if (row.load_kind !== "assistance") reasons.push(`${label}: load_kind 가 assistance 가 아니다`);
  if (row.assistance_provenance !== "legacy_performed" && row.assistance_provenance === null)
    reasons.push(`${label}: provenance 가 없다`);
  checkSafetyState(row, label, reasons);
}

/**
 * 세션 payload 를 그대로 렌더해도 되는가.
 * **어시스트 행이 하나도 없으면 safe** 다 — 다른 종목의 판정은 여기서 하지 않는다.
 */
export function assistanceSessionVerdict(rows: AssistanceSessionRow[]): AssistanceSafetyVerdict {
  const reasons: string[] = [];
  for (const row of rows) {
    if (!isAssistanceRow(row)) {
      // non-assisted 행은 assistance 축이 전부 비어 있어야 한다(기본값으로 채우지 않는다).
      if (row.assistance_provenance !== null) reasons.push("non-assisted 행에 provenance 가 있다");
      continue;
    }
    if (classifySessionRow(row) === "legacy_performed") checkLegacyPerformed(row, reasons);
    else checkUnperformed(row, reasons);
  }
  return { safe: reasons.length === 0, reasons };
}

export function isAssistanceSafeSession(rows: AssistanceSessionRow[]): boolean {
  return assistanceSessionVerdict(rows).safe;
}

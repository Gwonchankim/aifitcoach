import type { AssistanceProvenance, PlannedSet } from "@prisma/client";
import {
  RULES_BUNDLE_V1_ASSIST,
  isAllowedAssistanceVersion,
  isAssistanceSafeSession,
  provenanceFor,
  supportsAssistance,
} from "shared";
import type {
  AssistanceSessionRow,
  LoadKind,
  RecommendationState,
  RecommendedAction,
} from "shared";

/**
 * F-3 — 어시스트 semantics · provenance matrix · projector.
 *
 * **통증(pain_score)을 읽지 않는다.** provenance 판정은 performed fact 의 **유무**만 본다.
 * 그래서 이 파일 어디에도 복호화가 없고, 암호문·평문이 로그·audit 에 실릴 경로도 없다.
 *
 * DB constraint 와 **같은 불변식**을 여기서도 강제한다 — 한쪽만 좁으면 우회 경로가 생긴다.
 * 허용집합의 원천은 `packages/shared` 하나다(`ASSISTANCE_PROVENANCE_VERSIONS`).
 */

/** 어시스트 semantics 를 갖는 카탈로그 id. migration SQL 의 목록과 같아야 한다. */
export const ASSISTED_EXERCISE_IDS: readonly string[] = ["e_assisted_pullup"];

/**
 * canonical semantics. **시드·import 가 조용히 빠뜨릴 수 없게** 여기 한 곳에서만 정한다.
 * 목록에 없는 종목은 기본 `external_load` 이고, undefined 를 돌려주지 않는다.
 */
export function loadSemanticsFor(exerciseId: string): "assistance" | "external_load" {
  return isAssistedExercise(exerciseId) ? "assistance" : "external_load";
}

export function isAssistedExercise(exerciseId: string): boolean {
  return ASSISTED_EXERCISE_IDS.includes(exerciseId);
}

/**
 * performed fact 유무 × rules_version → provenance.
 * **unknown 버전은 fail closed** — shared 의 `resolveRulesBundle` 이 계산 전에 throw 한다.
 */
export function provenanceForRow(row: {
  rulesVersion: string;
  hasPerformedFact: boolean;
}): AssistanceProvenance {
  return provenanceFor({
    rulesVersion: row.rulesVersion,
    hasServerAppliedPerformedFact: row.hasPerformedFact,
  });
}

/** 생성 시점에 굳는 immutable snapshot. DB 의 세 컬럼 + 그 행의 rules_version 이다. */
export interface AssistanceSnapshot {
  loadSemantics: "assistance" | "external_load";
  assistanceStepKg: unknown;
  assistanceProvenance: AssistanceProvenance | null;
  rulesVersion: string;
}

/**
 * **service guard** — DB constraint 와 같은 허용집합.
 *
 * `ck_planned_assistance_matches_semantics`(semantics ⇔ provenance),
 * `ck_planned_assistance_snapshot`(provenance ⇔ step),
 * `ck_planned_assistance_version_matrix`(provenance ⇔ rules_version) 셋을 그대로 옮긴다.
 * exerciseId 가 아니라 **저장될 snapshot 자체**를 본다 — 카탈로그가 나중에 바뀌어도
 * 이미 굳은 행의 판정이 흔들리지 않아야 한다.
 */
export function assertAssistanceSnapshot(row: AssistanceSnapshot): void {
  const assisted = row.loadSemantics === "assistance";
  const hasStep = row.assistanceStepKg !== null && row.assistanceStepKg !== undefined;

  if (assisted && row.assistanceProvenance === null) {
    throw new Error("assistance 행에는 assistance_provenance 가 필요하다.");
  }
  if (!assisted && row.assistanceProvenance !== null) {
    throw new Error("external_load 행에는 assistance_provenance 를 넣지 않는다.");
  }
  if (row.assistanceProvenance === null) {
    if (hasStep) throw new Error("provenance 없이 assistance_step_kg 만 둘 수 없다.");
    return;
  }
  if (!hasStep) {
    throw new Error("assistance 행에는 assistance_step_kg 가 필요하다.");
  }
  if (!isAllowedAssistanceVersion(row.assistanceProvenance, row.rulesVersion)) {
    throw new Error(
      `provenance ${row.assistanceProvenance} 는 rules_version ${row.rulesVersion} 과 함께 저장할 수 없다.`,
    );
  }
}

/**
 * 어시스트 행이 실릴 rules bundle. **활성 포인터가 assistance 를 모르면 hotfix bundle 을 쓴다** —
 * `.08.1` 로 저장하면 그 행은 나중에 "도움 kg 을 일반 부하로 읽어야 하는 행"이 된다.
 * 포인터가 `.09` 로 올라가면 그 값을 그대로 쓴다(별도 분기를 남기지 않는다).
 */
export function rulesVersionForLoadSemantics(
  loadSemantics: "assistance" | "external_load",
  activeVersion: string,
): string {
  if (loadSemantics !== "assistance") return activeVersion;
  return supportsAssistance(activeVersion) ? activeVersion : RULES_BUNDLE_V1_ASSIST;
}

/** 종료 응답이 다음 세션 target 행들을 어떻게 다룰지. */
export type TargetCohort = "generic" | "assistance_safe" | "unsafe";

/** cohort 판정에 쓰는 target 행. 카탈로그가 아니라 **저장된 snapshot** 만 본다. */
export interface AssistanceTargetRow extends AssistanceSnapshot {
  reasonCode: string;
  recommendedWeight: unknown;
  confidence: unknown;
  /** **서버에 적용된** 수행 사실. 로컬 pending outbox 는 포함하지 않는다. */
  hasServerAppliedPerformedFact: boolean;
}

/** interim fail-safe 의 exact 값. factory 가 쓰는 것과 같아야 한다. */
const CALIBRATION_REASON = "ASSISTANCE_CALIBRATION_NEEDED";

function sameSnapshotAcross(rows: AssistanceTargetRow[]): boolean {
  const key = (row: AssistanceTargetRow): string =>
    JSON.stringify([
      row.loadSemantics,
      row.assistanceStepKg === null || row.assistanceStepKg === undefined
        ? null
        : String(row.assistanceStepKg),
      row.assistanceProvenance,
      row.rulesVersion,
      row.reasonCode,
      row.recommendedWeight === null || row.recommendedWeight === undefined
        ? null
        : String(row.recommendedWeight),
      String(row.confidence),
    ]);
  const first = key(rows[0]);
  return rows.every((row) => key(row) === first);
}

/**
 * **target snapshot cohort 판정.** 종료 응답이 무엇을 내보낼지, 그리고 저장 행을 갱신해도 되는지
 * 정한다. 판정 원천은 **저장된 snapshot + server-applied performed fact** 다 —
 * 카탈로그의 현재 `loadSemantics` 는 나중에 바뀔 수 있어 보지 않는다.
 *
 * 판정 규칙은 `packages/shared` 의 `isAssistanceSafeSession` **하나**를 쓴다. 서버 응답과
 * 오프라인 미러가 다른 규칙을 쓰면 rolling deploy 중 한쪽만 legacy 처방을 통과시킨다.
 *
 * `assistance_safe` 는 **전부 미수행이고 동일 cohort 이며 safe** 일 때만이다.
 * `legacy_performed` 가 **하나라도 섞이면 그 운동 전체가 `unsafe`** 다 — 일부만 갱신하면
 * 저장 행과 응답이 갈라지고, legacy 행의 `.08.1` 은 사실이라 옮길 수도 없다.
 */
export function classifyTargetCohort(rows: AssistanceTargetRow[]): TargetCohort {
  return classifyCohort(rows, { rejectPerformed: true });
}

/**
 * **입력(방금 수행한) cohort 판정.** target 과 달리 **수행 사실이 있는 것이 정상**이다 —
 * 그 행들이 바로 계산의 입력이다. 대신 uniformity·snapshot 유효성은 똑같이 요구한다.
 * 의미가 섞인 입력을 한 계산에 넣으면 도움 kg 을 부하로(또는 그 반대로) 읽는다.
 */
export function classifySourceCohort(rows: AssistanceTargetRow[]): TargetCohort {
  return classifyCohort(rows, { rejectPerformed: false });
}

function classifyCohort(
  rows: AssistanceTargetRow[],
  options: { rejectPerformed: boolean },
): TargetCohort {
  if (rows.length === 0) return "unsafe";
  if (rows.every((row) => row.loadSemantics === "external_load")) {
    // non-assisted 는 provenance/step 이 전부 NULL 이어야 한다(DB CHECK 와 같은 조건).
    return rows.every(
      (row) =>
        row.assistanceProvenance === null &&
        (row.assistanceStepKg === null || row.assistanceStepKg === undefined),
    )
      ? "generic"
      : "unsafe";
  }
  if (!rows.every((row) => row.loadSemantics === "assistance")) return "unsafe";
  // target 에 이미 수행된 행이 섞이면 그 운동 전체를 뺀다. 부분 갱신은 하지 않는다.
  if (options.rejectPerformed && rows.some((row) => row.hasServerAppliedPerformedFact))
    return "unsafe";
  if (!sameSnapshotAcross(rows)) return "unsafe";

  const row = rows[0];
  if (row.assistanceProvenance === null) return "unsafe";
  const step = Number(row.assistanceStepKg);
  if (!Number.isFinite(step) || step <= 0) return "unsafe";
  try {
    if (!isAllowedAssistanceVersion(row.assistanceProvenance, row.rulesVersion)) return "unsafe";
  } catch {
    // unknown rules version 은 fail closed 다 — 응답에서 뺀다.
    return "unsafe";
  }
  return isAssistanceSafeSession(rows.map(toSessionRow)) ? "assistance_safe" : "unsafe";
}

/** wire 로 나가는 안전 판정. non-assisted 는 판정 대상이 아니라 null 이다. */
export type AssistanceSafetyStatus = "safe" | "unsafe";

/** 최소 경계에서만 붙는 제안. 안전 상태·비어시스트는 null 이다(§F). */
export function recommendedActionFor(reasonCode: string): RecommendedAction | null {
  return reasonCode === "ASSISTANCE_MINIMUM_REACHED"
    ? { kind: "suggest_exercise_swap", exercise_id: "e_pullup" }
    : null;
}

/** 저장 행 + 서버 적용 수행 사실 → 판정 입력. 게이트를 거치지 않은 raw 값이다. */
export function toRawTargetRow(
  set: {
    loadSemantics: "assistance" | "external_load";
    assistanceStepKg: unknown;
    assistanceProvenance: AssistanceProvenance | null;
    rulesVersion: string;
    reasonCode: string;
    recommendedWeight: unknown;
    confidence: unknown;
  },
  hasServerAppliedPerformedFact: boolean,
): AssistanceTargetRow {
  return {
    loadSemantics: set.loadSemantics,
    assistanceStepKg: set.assistanceStepKg,
    assistanceProvenance: set.assistanceProvenance,
    rulesVersion: set.rulesVersion,
    reasonCode: set.reasonCode,
    recommendedWeight: set.recommendedWeight,
    confidence: set.confidence,
    hasServerAppliedPerformedFact,
  };
}

/**
 * **표시 게이트를 적용하기 전의 raw 행**으로 판정한다. 게이트가 값을 가렸다고 그 행이 안전해지지
 * 않는다 — 가려진 legacy 처방은 게이트가 열리는 순간 그대로 드러난다.
 *
 * non-assisted 는 `null` 이다(판정 대상 아님). 클라이언트는 **null·누락·unsafe 를 전부
 * fail closed** 로 다뤄 marker 를 유지한다.
 */
export function rawAssistanceSafetyStatus(row: AssistanceTargetRow): AssistanceSafetyStatus | null {
  if (row.loadSemantics !== "assistance") return null;
  return isAssistanceSafeSession([toSessionRow(row)]) ? "safe" : "unsafe";
}

/** 저장 행 → shared predicate 입력. 상태·부하 축은 저장값에서 되살린다. */
function toSessionRow(row: AssistanceTargetRow): AssistanceSessionRow {
  const weight =
    row.recommendedWeight === null || row.recommendedWeight === undefined
      ? null
      : Number(row.recommendedWeight);
  return {
    load_semantics: row.loadSemantics,
    load_kind: row.loadSemantics === "assistance" ? "assistance" : "external",
    assistance_provenance: row.assistanceProvenance,
    rules_version: row.rulesVersion,
    recommendation_state: stateForReasonCode(row.reasonCode),
    reason_code: row.reasonCode,
    recommended_weight: weight,
    recommended_action:
      row.reasonCode === "ASSISTANCE_MINIMUM_REACHED"
        ? { kind: "suggest_exercise_swap", exercise_id: "e_pullup" }
        : null,
    has_server_applied_performed_fact: row.hasServerAppliedPerformedFact,
  };
}

/**
 * 저장 행의 부하 축 의미. **표시 게이트에 가려진 값이 아니라 raw 값**으로 판정한다 —
 * `load_kind` 는 "이 종목의 부하 축이 무엇인가"라는 구조적 사실이고, 게이트가 숨기는 것은
 * 숫자뿐이다. 게이트된 weight 로 판정하면 external 행이 bodyweight 로 뒤바뀐다.
 */
export function loadKindForSnapshot(row: {
  loadSemantics: "assistance" | "external_load";
  targetTimeHighSec: number | null;
  recommendedWeight: unknown;
}): LoadKind {
  if (row.loadSemantics === "assistance") return "assistance";
  if (row.targetTimeHighSec !== null) return "not_applicable";
  return row.recommendedWeight === null || row.recommendedWeight === undefined
    ? "bodyweight"
    : "external";
}

/** 저장 행에는 상태 컬럼이 없다 — reason 이 유일한 원천이다. */
export function stateForReasonCode(reason: string): RecommendationState {
  if (reason === "SUBSTITUTE_PAIN") return "substitution_required";
  if (reason === "INVALID_INPUT") return "unavailable";
  if (reason === CALIBRATION_REASON || reason === "LOAD_CALIBRATION_NEEDED")
    return "load_calibration_needed";
  return "ready";
}

/**
 * **snapshot 기반 projector.** 카탈로그를 다시 읽지 않는다 —
 * 저장된 snapshot 만 보므로 카탈로그가 나중에 바뀌어도 과거 행의 해석이 고정된다.
 */
export function projectAssistanceSnapshot(
  row: Pick<PlannedSet, "assistanceProvenance" | "assistanceStepKg" | "recommendedWeight">,
): {
  load_kind: "assistance" | "external";
  assistance_provenance: AssistanceProvenance | null;
  assistance_kg: number | null;
  assistance_step_kg: number | null;
} {
  if (row.assistanceProvenance === null || row.assistanceProvenance === undefined) {
    return {
      load_kind: "external",
      assistance_provenance: null,
      assistance_kg: null,
      assistance_step_kg: null,
    };
  }
  const weight = row.recommendedWeight === null ? null : Number(row.recommendedWeight);
  return {
    load_kind: "assistance",
    assistance_provenance: row.assistanceProvenance,
    // 도움 kg 은 양수로만 저장·표시한다. 음수·0 은 만들지 않는다.
    assistance_kg: weight !== null && weight > 0 ? weight : null,
    assistance_step_kg: row.assistanceStepKg === null ? null : Number(row.assistanceStepKg),
  };
}

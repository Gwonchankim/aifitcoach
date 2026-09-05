/**
 * 규칙 묶음(rules bundle) 버전. 추천 엔진 출력과 프로그램 생성 정책이 **하나의 버전**을 공유한다
 * (ADR-71, docs/PROGRAM_V2_CONTRACT.md §2.6). 엔진용·프로그램용 상수를 따로 두지 않는다.
 *
 * 활성화는 원자적이다 — V2 bundle 은 예약만 해 두고, PLAN(B+C·S/C/H·packer)까지 끝난
 * activation 티켓에서 `ROUTINE_RULES_VERSION` 포인터를 한 번에 옮긴다.
 */

/** 현재 활성 bundle. 엔진 출력만 V2로 바뀐 중간 상태에 V2 버전을 찍으면 거짓말이 된다. */
export const RULES_BUNDLE_V1 = "2026.08.1";

/**
 * 예약 bundle. V1 schedule/sets 를 유지한 채 **어시스트 의미만 고치는** hotfix 다.
 * `.09.0` 과 독립이라 먼저 나갈 수 있다(F 트랙).
 */
export const RULES_BUNDLE_V1_ASSIST = "2026.08.2";

/** 예약 bundle. external 무이력이 `null + LOAD_CALIBRATION_NEEDED` 가 되는 계약. */
export const RULES_BUNDLE_V2 = "2026.09.0";

/**
 * 예약 bundle. `.09.0` 위에 **개편 S/C/H composition + split preference**를 더한다(ADR-73).
 * 전체 V2 구성과 CARDIO baseline 검증 후 한 번에 활성화한다. 중간 V1에 쓰지 않는다.
 * 정책 구현은 Sprint04/05 소유지만, **상수·union·판정은 여기 있어야** 한다 —
 * 없으면 `.09.1` 이 unknown 으로 throw 해서 어시스트 계약이 그 버전에서 끊긴다.
 */
export const RULES_BUNDLE_V2_SPLIT = "2026.09.1";

export type RulesBundle =
  | typeof RULES_BUNDLE_V1
  | typeof RULES_BUNDLE_V1_ASSIST
  | typeof RULES_BUNDLE_V2
  | typeof RULES_BUNDLE_V2_SPLIT;

export const SUPPORTED_RULES_BUNDLES: readonly RulesBundle[] = [
  RULES_BUNDLE_V1,
  RULES_BUNDLE_V1_ASSIST,
  RULES_BUNDLE_V2,
  RULES_BUNDLE_V2_SPLIT,
];

/**
 * 지원 bundle 로 resolve. **equality 로만 판정한다** — `version >= "2026.09.0"` 같은 문자열 범위
 * 비교는 정렬 순서가 버전 의미를 보장하지 않으므로 쓰지 않는다(예: `"2026.10.0" < "2026.9.0"`).
 *
 * 지원하지 않는 문자열은 **fail closed — 계산 전에 throw 한다.** `rules_version` 은 사용자 입력이
 * 아니라 내부 상수에서만 온다(api `RULES_VERSION`, 오프라인 미러 `ROUTINE_RULES_VERSION`).
 * 따라서 모르는 값이 들어왔다면 배포 오류이고, 조용히 V1 로 떨어뜨리면 **결과에 잘못된 provenance
 * 가 박힌 채 저장된다** — 나중에 그 행을 어느 규칙으로 해석해야 하는지 알 수 없게 된다.
 */
export function resolveRulesBundle(rulesVersion: string): RulesBundle {
  if (rulesVersion === RULES_BUNDLE_V1) return RULES_BUNDLE_V1;
  if (rulesVersion === RULES_BUNDLE_V1_ASSIST) return RULES_BUNDLE_V1_ASSIST;
  if (rulesVersion === RULES_BUNDLE_V2) return RULES_BUNDLE_V2;
  if (rulesVersion === RULES_BUNDLE_V2_SPLIT) return RULES_BUNDLE_V2_SPLIT;
  throw new RangeError(
    `지원하지 않는 rules_version: ${JSON.stringify(rulesVersion)}. ` +
      `지원 버전: ${SUPPORTED_RULES_BUNDLES.join(", ")}`,
  );
}

/**
 * V2 계약 여부. 지원하지 않는 버전이면 `resolveRulesBundle` 이 throw 한다.
 * `.09.1` 은 composition/split를 개편하지만 **V2 추천 출력 계약을 그대로 따른다.**
 */
export function isV2RulesBundle(rulesVersion: string): boolean {
  const bundle = resolveRulesBundle(rulesVersion);
  return bundle === RULES_BUNDLE_V2 || bundle === RULES_BUNDLE_V2_SPLIT;
}

/**
 * 어시스트 의미(도움 kg)를 아는 bundle 인가. `2026.08.1` 은 **모른다** —
 * 그 버전의 저장된 행은 지금도 일반 가중 운동으로 해석해야 재현이 맞는다.
 */
export function supportsAssistance(rulesVersion: string): boolean {
  const bundle = resolveRulesBundle(rulesVersion);
  return (
    bundle === RULES_BUNDLE_V1_ASSIST ||
    bundle === RULES_BUNDLE_V2 ||
    bundle === RULES_BUNDLE_V2_SPLIT
  );
}

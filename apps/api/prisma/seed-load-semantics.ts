/**
 * 시드가 쓰는 load_semantics 판정. 시드가 API 런타임(src/programs/assistance-migration.ts)에 묶이지 않도록
 * 시드에 필요한 계약만 둔다: 어시스트 머신 2종은 `assistance`, 그 밖의 모든 ID 는 `external_load`.
 *
 * 원천: docs/CATALOG_EXTENSION.md(어시스트 종목 2종). 목록 밖·모르는 ID 도 undefined 가 아니라
 * `external_load` 를 돌려준다 — 시드가 값을 조용히 빠뜨리지 않게 한다.
 */
const ASSISTED_EXERCISE_IDS: ReadonlySet<string> = new Set([
  "e_assisted_pullup",
  "e_assisted_dips",
]);

export function loadSemanticsFor(exerciseId: string): "assistance" | "external_load" {
  return ASSISTED_EXERCISE_IDS.has(exerciseId) ? "assistance" : "external_load";
}

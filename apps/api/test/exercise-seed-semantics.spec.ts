import seedJson from "../../../docs/specs/exercises_seed.json";
import { loadSemanticsFor, ASSISTED_EXERCISE_IDS } from "../src/programs/assistance-migration";

const seed = seedJson as { exercises: { id: string }[] };

/**
 * F-3 — 시드·import guard.
 *
 * `load_semantics` 는 canonical 이라 **시드가 조용히 빠뜨리면 안 된다.**
 * 빠뜨린 채 통과하면 어시스트 종목이 일반 가중 운동으로 적재돼 F 전체가 무의미해진다.
 */

describe("시드 load_semantics guard", () => {
  it("어시스트 목록에 있는 종목은 assistance 다", () => {
    for (const id of ASSISTED_EXERCISE_IDS) {
      expect(loadSemanticsFor(id)).toBe("assistance");
    }
  });

  it("그 밖의 종목은 external_load 가 기본이다", () => {
    expect(loadSemanticsFor("e_chest_press_machine")).toBe("external_load");
    expect(loadSemanticsFor("e_pullup")).toBe("external_load");
  });

  it("시드 파일의 어시스트 종목이 실제로 존재한다 — 목록만 남고 데이터가 사라지면 잡는다", () => {
    const ids = new Set(seed.exercises.map((e) => e.id));
    for (const id of ASSISTED_EXERCISE_IDS) {
      expect(`${id}:${ids.has(id)}`).toBe(`${id}:true`);
    }
  });

  it("시드 전 종목이 semantics 를 받는다 — 누락 0", () => {
    const missing = seed.exercises.filter((e) => loadSemanticsFor(e.id) === undefined);
    expect(missing.map((e) => e.id)).toEqual([]);
  });
});

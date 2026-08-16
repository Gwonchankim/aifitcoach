/**
 * M-4′ red suite의 단언 자체를 검증한다.
 * production projector를 흉내 내는 테스트가 아니라, 잘못된 후보를 각 축에서 실제로 거부하는지 확인하는
 * 메타 테스트다. 실제 API/projector red는 test/m4-contract.red.ts가 소유한다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

type ProjectionProof = {
  sampleSessionCount: number;
  gateState: string;
  firstE1rm: number;
  orderedSessionIds: string[];
  incrementalRows: unknown[];
  rebuildRows: unknown[];
};

const fixture = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "..", "..", "..", "docs", "specs", "m4_aggregation_fixture.json"),
    "utf8",
  ),
) as {
  expected: {
    sample_session_count: number;
    gate_state: string;
    first_e1rm: number;
    ordered_session_ids: string[];
  };
};

function verify(candidate: ProjectionProof): void {
  expect(candidate.sampleSessionCount).toBe(fixture.expected.sample_session_count);
  expect(candidate.gateState).toBe(fixture.expected.gate_state);
  expect(candidate.firstE1rm).toBe(fixture.expected.first_e1rm);
  expect(candidate.orderedSessionIds).toEqual(fixture.expected.ordered_session_ids);
  expect(JSON.stringify(candidate.incrementalRows)).toBe(JSON.stringify(candidate.rebuildRows));
}

const correct: ProjectionProof = {
  sampleSessionCount: 3,
  gateState: "ready",
  firstE1rm: 123.33,
  orderedSessionIds: ["s-01", "s-02", "s-03"],
  incrementalRows: [{ session_id: "s-01", e1rm: 123.33 }],
  rebuildRows: [{ session_id: "s-01", e1rm: 123.33 }],
};

describe("M-4′ 집계 red-proof 하네스", () => {
  it("승인 fixture의 정상 후보는 통과한다", () => {
    expect(() => verify(correct)).not.toThrow();
  });

  it("삽입 순서를 그대로 반환하는 후보를 거부한다", () => {
    expect(() => verify({ ...correct, orderedSessionIds: ["s-03", "s-01", "s-02"] })).toThrow(
      /toEqual/,
    );
  });

  it("증분 갱신과 전체 rebuild가 다른 후보를 거부한다", () => {
    expect(() =>
      verify({ ...correct, incrementalRows: [{ session_id: "s-01", e1rm: 116.67 }] }),
    ).toThrow(/toBe/);
  });

  it("한 세션의 세 세트를 3세션으로 세는 후보를 거부한다", () => {
    expect(() => verify({ ...correct, sampleSessionCount: 1, gateState: "early" })).toThrow(/toBe/);
  });

  it("RIR 보정 없는 raw Epley 후보를 거부한다", () => {
    expect(() => verify({ ...correct, firstE1rm: 116.67 })).toThrow(/toBe/);
  });
});

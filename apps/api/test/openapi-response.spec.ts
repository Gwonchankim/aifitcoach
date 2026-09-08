/**
 * 검증기 자기검증: `expectMatchesContract` 가 실제로 openapi 의 required/타입을 강제하는지 확인한다.
 * (이게 없으면 "스키마 검증 통과"가 아무것도 보장하지 않는 통과가 될 수 있다 — STEP 2 I-1.)
 */
import {
  expectErrorMatchesContract,
  expectMatchesContract,
  responseValidator,
} from "./support/openapi-response";

const VALID_SESSION = {
  id: "s_1",
  program_id: "p_1",
  goal: "hypertrophy",
  scheduled_date: "2026-08-05",
  status: "scheduled",
  planned_sets: [
    {
      id: "ps_1",
      source_revision: "fixture-source-revision",
      correlation_id: null,
      append_eligibility: null,
      exercise_id: "e_bench_press",
      set_no: 1,
      target_reps_low: 6,
      target_reps_high: 12,
      target_rir: 2,
      rest_sec: 120,
      recommended_weight: 62.5,
      recommended_reps: 6,
      reason_code: "BASELINE",
      confidence: 0.5,
      rules_version: "2026.07.1",
      load_kind: "external",
      recommendation_state: "ready",
      // non-assisted 는 provenance·action·verdict 가 **전부 null** 이다 — 이 fixture 가 그 계약을
      // 함께 잠근다(§F). 기본값·빈 문자열로 채우면 클라이언트가 어시스트 행으로 오인한다.
      assistance_provenance: null,
      recommended_action: null,
      assistance_safety_status: null,
      recommendation_gate: "no_history",
      performed_set: null,
    },
  ],
};

describe("openapi 응답 검증기", () => {
  it("계약을 만족하는 바디는 통과한다", () => {
    expect(() =>
      expectMatchesContract("get", "/sessions/{sessionId}", 200, VALID_SESSION),
    ).not.toThrow();
  });

  it.each(Object.keys(VALID_SESSION))("Session 의 required 필드 %s 가 빠지면 실패한다", (field) => {
    const body: Record<string, unknown> = { ...VALID_SESSION };
    delete body[field];

    expect(() => expectMatchesContract("get", "/sessions/{sessionId}", 200, body)).toThrow(
      /openapi 스키마를 위반한다/,
    );
  });

  it.each(Object.keys(VALID_SESSION.planned_sets[0]))(
    "PlannedSet 의 required 필드 %s 가 빠지면 실패한다",
    (field) => {
      const set: Record<string, unknown> = { ...VALID_SESSION.planned_sets[0] };
      delete set[field];

      expect(() =>
        expectMatchesContract("get", "/sessions/{sessionId}", 200, {
          ...VALID_SESSION,
          planned_sets: [set],
        }),
      ).toThrow(/openapi 스키마를 위반한다/);
    },
  );

  it("타입이 다르면 실패한다(recommended_weight 를 문자열로)", () => {
    expect(() =>
      expectMatchesContract("get", "/sessions/{sessionId}", 200, {
        ...VALID_SESSION,
        planned_sets: [{ ...VALID_SESSION.planned_sets[0], recommended_weight: "62.5" }],
      }),
    ).toThrow(/openapi 스키마를 위반한다/);
  });

  it("enum 밖의 값이면 실패한다(status)", () => {
    expect(() =>
      expectMatchesContract("get", "/sessions/{sessionId}", 200, {
        ...VALID_SESSION,
        status: "done",
      }),
    ).toThrow(/openapi 스키마를 위반한다/);
  });

  /**
   * openapi 에 additionalProperties:false 가 없어 ajv 만으로는 여분 필드가 통과한다.
   * 여분 필드 = 유출 경로(평문 pain·user_id) 라서 키셋 단언으로 막는다(STEP 4 평가 PIPA 결함).
   */
  describe("선언되지 않은 키(여분 필드) 차단", () => {
    it("최상위에 없는 키가 있으면 실패한다(user_id 유출)", () => {
      expect(() =>
        expectMatchesContract("get", "/sessions/{sessionId}", 200, {
          ...VALID_SESSION,
          user_id: "00000000-0000-4000-8000-000000000001",
        }),
      ).toThrow(/openapi 에 없는 키가 있다: \$\.user_id/);
    });

    it("중첩 객체에 없는 키가 있으면 실패한다(session_feedback.pain 평문)", () => {
      expect(() =>
        expectMatchesContract("post", "/sessions/{sessionId}/complete", 200, {
          session: { ...VALID_SESSION, session_feedback: { pain: 3 } },
          next_recommendations: [],
        }),
      ).toThrow(/\$\.session\.session_feedback/);
    });

    it("배열 원소(PlannedSet)에 없는 키가 있으면 실패한다", () => {
      expect(() =>
        expectMatchesContract("get", "/sessions/{sessionId}", 200, {
          ...VALID_SESSION,
          planned_sets: [{ ...VALID_SESSION.planned_sets[0], pain_score: 5 }],
        }),
      ).toThrow(/\$\.planned_sets\[0\]\.pain_score/);
    });

    it("Program 템플릿의 중첩 배열(sessions[].exercises[])도 검사한다", () => {
      expect(() =>
        expectMatchesContract("get", "/programs/current", 200, {
          program_id: "p_1",
          goal: "hypertrophy",
          split_type: "upper_lower",
          rules_version: "2026.07.1",
          started_at: "2026-08-04",
          total_weeks: 12,
          current_week: 1,
          status: "active",
          excluded_exercises: [],
          sessions: [
            {
              day: "MON",
              focus: "upper",
              exercises: [
                {
                  exercise_id: "e_bench_press",
                  sets: 3,
                  reps_low: 6,
                  reps_high: 12,
                  target_rir: 2,
                  rest_sec: 120,
                  internal_note: "leak",
                },
              ],
            },
          ],
        }),
      ).toThrow(/\$\.sessions\[0\]\.exercises\[0\]\.internal_note/);
    });

    it("Recommendation 에 없는 키가 있으면 실패한다", () => {
      expect(() =>
        expectMatchesContract("post", "/sessions/{sessionId}/complete", 200, {
          session: VALID_SESSION,
          next_recommendations: [
            {
              exercise_id: "e_bench_press",
              sample_session_count: 3,
              gate_state: "ready",
              recommendation: {
                exercise_id: "e_bench_press",
                weight: 62.5,
                reps_low: 6,
                reps_high: 12,
                sets: 3,
                reason_code: "BASELINE",
                confidence: 0.5,
                explanation: "기록이 없다",
                rules_version: "2026.07.1",
                load_kind: "external",
                recommendation_state: "ready",
                recommended_action: null,
                // **테스트 전용 sentinel.** 제품 필드 이름을 쓰면 그 필드가 정식 계약이 되는 날
                // 이 테스트의 의미가 조용히 뒤집힌다(실제로 load_kind 를 쓰다 그렇게 됐다).
                // 이 이름은 production schema 에 절대 추가하지 않는다.
                unexpected_contract_field: "leak",
              },
            },
          ],
        }),
      ).toThrow(/\$\.next_recommendations\[0\]\.recommendation\.unexpected_contract_field/);
    });
  });

  /**
   * 상태코드 축 자기검증: 에러 계약 검사가 (a) 다른 상태코드, (b) 계약에 없는 상태코드,
   * (c) Error 엔벨로프가 아닌 바디를 실제로 잡아내는지 확인한다.
   */
  describe("에러 응답(상태코드 축) 검증기", () => {
    const ADD_PATH = "/sessions/{sessionId}/exercises";
    const CONFLICT = { error: { code: "CONFLICT", message: "이미 이 세션에 포함된 운동입니다" } };

    it("계약대로면 통과한다", () => {
      expect(() =>
        expectErrorMatchesContract("post", ADD_PATH, 409, { status: 409, body: CONFLICT }),
      ).not.toThrow();
    });

    it("구현이 다른 상태코드를 내면 실패한다(409 대신 400)", () => {
      expect(() =>
        expectErrorMatchesContract("post", ADD_PATH, 409, { status: 400, body: CONFLICT }),
      ).toThrow(/상태코드가 409 여야 하는데 400 다/);
    });

    it("계약에 선언되지 않은 상태코드면 실패한다", () => {
      expect(() =>
        expectErrorMatchesContract("post", ADD_PATH, 403, { status: 403, body: CONFLICT }),
      ).toThrow(/openapi 에 응답 스키마가 없다/);
    });

    it("Error 엔벨로프가 아니면 실패한다", () => {
      expect(() =>
        expectErrorMatchesContract("post", ADD_PATH, 409, {
          status: 409,
          body: { message: "conflict" },
        }),
      ).toThrow(/openapi 스키마를 위반한다/);
    });
  });

  it("openapi 에 없는 경로/상태코드를 검증하려 하면 즉시 실패한다(오타 방지)", () => {
    expect(() => responseValidator("get", "/sessions/{sessionId}", 418)).toThrow(
      /openapi 에 응답 스키마가 없다/,
    );
    expect(() => responseValidator("get", "/not/a/path", 200)).toThrow(
      /openapi 에 응답 스키마가 없다/,
    );
  });
});

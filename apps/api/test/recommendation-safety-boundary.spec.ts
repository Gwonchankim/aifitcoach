import type { PainObservation } from "shared";
import { RecommendationService } from "../src/recommendation/recommendation.service";
import type { ExerciseHistory } from "../src/recommendation/recommendation.service";
import type { PrismaService } from "../src/prisma/prisma.service";

/**
 * F fixup-code-review-02 항목 2 — **DB 없는 service 경계**.
 *
 * `safetyInputFor` 가 옳은 값을 만들어도 `recommend()` 가 그것을 엔진 입력에 **실제로 합성하지
 * 않으면** 아무 의미가 없다. 어댑터 단위 테스트만으로는 그 배선이 끊긴 걸 못 잡는다.
 * 여기서는 서비스가 만든 **최종 결과**로 배선을 잠근다.
 */

// recommend() 는 prisma 를 쓰지 않는다. 배선만 보므로 DB 를 띄우지 않는다.
const service = new RecommendationService({} as PrismaService);

const EXTERNAL = {
  mechanic: "compound",
  region: "upper",
  defaultStepKg: { toString: () => "2.5" },
  metric: "reps",
} as unknown as Parameters<RecommendationService["recommend"]>[0]["exercise"];

const TIME = {
  mechanic: "isolation",
  region: "core",
  defaultStepKg: null,
  metric: "time",
} as unknown as Parameters<RecommendationService["recommend"]>[0]["exercise"];

function history(pain: PainObservation | undefined, sets: ExerciseHistory["lastSets"]) {
  return pain === undefined ? { lastSets: sets } : { lastSets: sets, pain };
}

describe("service 경계 — external 종목의 safety 합성", () => {
  const target = { reps_low: 8, reps_high: 12, rir: 2 };
  const sets = [{ w: 60, reps: 12, rir: 2 }];

  it("pain 없음 → 정상 진행", () => {
    const r = service.recommend({
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target,
      history: history(undefined, sets),
    });
    expect(r.recommendation_state).toBe("ready");
    expect(r.reason_code).toBe("WEIGHT_UP_REP_TARGET_MET");
  });

  it("pain 4 → substitution_required 가 실제로 나온다", () => {
    const r = service.recommend({
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target,
      history: history({ kind: "value", value: 4 }, sets),
    });
    expect(r.recommendation_state).toBe("substitution_required");
    expect(r.reason_code).toBe("SUBSTITUTE_PAIN");
  });

  it("pain 3 → 가드레일이 발동하지 않는다(임계 반대편)", () => {
    const r = service.recommend({
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target,
      history: history({ kind: "value", value: 3 }, sets),
    });
    expect(r.recommendation_state).toBe("ready");
  });

  it("decrypt 실패 → unavailable 이 실제로 나온다 (배선이 끊기면 ready 가 된다)", () => {
    const r = service.recommend({
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target,
      history: history({ kind: "invalid", failure_code: "decrypt_failed" }, sets),
    });
    expect(r.recommendation_state).toBe("unavailable");
    expect(r.reason_code).toBe("INVALID_INPUT");
  });

  it("auth/nonnumeric 도 같은 fail-closed 의미다", () => {
    for (const failure of ["auth_failed", "nonnumeric"] as const) {
      const r = service.recommend({
        goal: "hypertrophy",
        exercise: EXTERNAL,
        target,
        history: history({ kind: "invalid", failure_code: failure }, sets),
      });
      expect(r.recommendation_state).toBe("unavailable");
    }
  });
});

describe("service 경계 — 시간 종목도 같은 의미다", () => {
  const target = { time_low_sec: 20, time_high_sec: 60 };
  const sets = [{ time_sec: 45 }];

  it("pain 5 → substitution_required", () => {
    const r = service.recommend({
      goal: "hypertrophy",
      exercise: TIME,
      target,
      history: history({ kind: "value", value: 5 }, sets),
    });
    expect(r.recommendation_state).toBe("substitution_required");
  });

  it("decrypt 실패 → unavailable", () => {
    const r = service.recommend({
      goal: "hypertrophy",
      exercise: TIME,
      target,
      history: history({ kind: "invalid", failure_code: "auth_failed" }, sets),
    });
    expect(r.recommendation_state).toBe("unavailable");
    expect(r.reason_code).toBe("INVALID_INPUT");
  });

  it("pain 없음 → 정상 진행", () => {
    const r = service.recommend({
      goal: "hypertrophy",
      exercise: TIME,
      target,
      history: history(undefined, sets),
    });
    expect(r.reason_code).toBe("TIME_HOLD");
  });
});

describe("service 경계 — 배선이 사라지면 잡힌다", () => {
  it("safety 를 합성하지 않으면 pain 4 가 조용히 진행된다", () => {
    // 이 단언이 통과한다 = 배선이 살아 있다. spread 를 제거하면 ready 가 되어 실패한다.
    const painful = service.recommend({
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: { reps_low: 8, reps_high: 12, rir: 2 },
      history: history({ kind: "value", value: 4 }, [{ w: 60, reps: 12, rir: 2 }]),
    });
    const healthy = service.recommend({
      goal: "hypertrophy",
      exercise: EXTERNAL,
      target: { reps_low: 8, reps_high: 12, rir: 2 },
      history: history(undefined, [{ w: 60, reps: 12, rir: 2 }]),
    });
    expect(painful.recommendation_state).not.toBe(healthy.recommendation_state);
  });
});

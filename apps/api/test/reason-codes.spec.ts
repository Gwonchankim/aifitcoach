import { RecommendationService } from "../src/recommendation/recommendation.service";
import type { PrismaService } from "../src/prisma/prisma.service";

/**
 * V2-REASON-01 호환 회귀.
 * runtime union 에서 제거한 코드가 **이미 저장돼 있던 행**에 남아 있을 수 있다(수동·과거 환경).
 * 그 행을 읽을 때 서버가 깨지거나 `undefined` explanation 을 내보내지 않아야 한다.
 *
 * `plannedToApi` 는 prisma 를 쓰지 않는 순수 매핑이라 DB 없이 검증한다.
 */
describe("제거된 reason_code 의 persisted 호환", () => {
  const service = new RecommendationService(undefined as unknown as PrismaService);

  const planned = (reasonCode: string) => ({
    recommendedWeight: { toString: () => "60" },
    recommendedReps: 10,
    targetRepsLow: 8,
    targetRepsHigh: 12,
    targetTimeLowSec: null,
    targetTimeHighSec: null,
    reasonCode,
    confidence: { toString: () => "0.85" },
    rulesVersion: "2026.08.1",
  });

  const FALLBACK = "최근 완료 기록을 반영한 다음 세션 추천이다.";

  // union 에서 제거된 6종 전부. 하나라도 map 에 남아 있으면 그 코드만 특정 문구가 나와 실패한다.
  const REMOVED = [
    "VOLUME_SPIKE_CAP",
    "DELOAD_SUGGESTED",
    "RIR_ON_TARGET_HOLD",
    "CALIBRATION_NEEDED",
    "CALIBRATION_GRADUATED",
    "CALIBRATION_STALE",
  ];

  it.each(REMOVED)("%s 는 일반 explanation 으로 저하된다(map 잔존 시 실패)", (code) => {
    const api = service.plannedToApi("e_bench_press", 3, planned(code));
    expect(api.explanation).toBe(FALLBACK);
  });

  it("reason_code 문자열 자체는 그대로 전달한다(DB 값을 변조하지 않는다)", () => {
    const api = service.plannedToApi("e_bench_press", 3, planned("VOLUME_SPIKE_CAP"));
    expect(api.reason_code).toBe("VOLUME_SPIKE_CAP");
  });

  it("살아 있는 코드는 여전히 고유 문구를 낸다(fallback 이 전부를 삼키지 않는다)", () => {
    const api = service.plannedToApi("e_bench_press", 3, planned("WEIGHT_UP_REP_TARGET_MET"));
    expect(api.explanation).not.toBe(FALLBACK);
    expect(api.explanation.length).toBeGreaterThan(0);
  });
});

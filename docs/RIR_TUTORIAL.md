# RIR 캘리브레이션 튜토리얼

- 목적: RIR 미숙련자가 RIR을 정확히 판단하도록 학습하고 개인 `rir_bias` 산출(초보는 남은 반복 ~4-5회 과소평가).
- 프로그램/데이터: `specs/tutorial_program_rir.json`(적응형 3~7일, 머신 위주, 졸업 tolerance ±1.5회).
- 산출물: `user_rir_calibration { bias_overall, bias_by_region, confidence, samples, last_calibrated_at, status }`.
- 적용: 메인 프로그램의 `corrected_RIR = clamp(reported_RIR + rir_bias, 0, 6)` (RECOMMENDATION_ENGINE.md).
- 스킵: advanced 기본 스킵 + 1세트 정확도 게이트(±1.5회 이내면 스킵 확정).
- 안전: 머신·안정 종목만, AMRAP 0~1 RIR까지, 운동당 실패 근접 1회, 통증 시 중단.
- 우선순위: target RIR 표시·수집=MVP(P0), 튜토리얼·bias·RIR 오토레귤레이션=P1.

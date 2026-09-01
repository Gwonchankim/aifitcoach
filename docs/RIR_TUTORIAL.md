# RIR 캘리브레이션 튜토리얼

> ## ⚠ 상태 전환이 구현돼 있지 않다 (2026-08-23 실측, V2-ENGINE-02 인벤토리)
>
> 스키마는 완비돼 있으나 **애플리케이션 write path가 0개**다.
>
> - `POST /me/calibration` → `apps/api/src/users/users.controller.ts:61-65`가 **`notImplemented()`** 반환.
> - `UserRirCalibration`을 쓰는 프로덕션 코드 없음. `grep -rn "userRirCalibration" --include=*.ts` 결과는
>   읽기 1곳(`recommendation.service.ts:79`)과 **테스트 픽스처·정리 4곳**뿐이다. seed도 만들지 않는다.
> - 따라서 **신규 사용자는 `graduated`에 도달할 수 없고**, RIR 기반 증량 경로
>   (`RIR_TOO_EASY_INCREASE`)는 현재 프로덕션에서 **도달 불가**다. 실사용 증량 근거는 reps 더블 프로그레션뿐이다.
>
> **소유 티켓: `V2-RIR-01`(not_started → in_progress → graduated 실제 경로 + bias 저장).
> V2 공개 전 완료 게이트다.** `V2-ENGINE-02`는 엔진 계약만 고정하고 이 상태 머신을 구현하지 않는다.
>
> 다만 **애플리케이션 write path가 없다는 것과 행이 없다는 것은 다르다.** 관리자·수동·과거 환경에서
> 생긴 행의 가능성을 배제할 근거가 없으므로, 기존 `graduated` 행은 현행처럼 **유효한 측정 calibration으로
> 보존**하고 해석을 바꾸지 않는다(migration 없음).

- 목적: RIR 미숙련자가 RIR을 정확히 판단하도록 학습하고 개인 `rir_bias` 산출(초보는 남은 반복 ~4-5회 과소평가).
- 프로그램/데이터: `specs/tutorial_program_rir.json`(적응형 3~7일, 머신 위주, 졸업 tolerance ±1.5회).
- 산출물: `user_rir_calibration { bias_overall, bias_by_region, confidence, samples, last_calibrated_at, status }`.
- 적용: 메인 프로그램의 `corrected_RIR = clamp(reported_RIR + rir_bias, 0, 6)` (RECOMMENDATION_ENGINE.md).
- 스킵: advanced 기본 스킵 + 1세트 정확도 게이트(±1.5회 이내면 스킵 확정).
- 안전: 머신·안정 종목만, AMRAP 0~1 RIR까지, 운동당 실패 근접 1회, 통증 시 중단.
- 우선순위: target RIR 표시·수집=MVP(P0), 튜토리얼·bias·RIR 오토레귤레이션=P1.

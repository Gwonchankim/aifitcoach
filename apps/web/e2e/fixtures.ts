/**
 * 모든 E2E 가 쓰는 `test` — 브라우저 시계를 API 와 같은 날짜로 옮긴다(ADR-50).
 *
 * 왜 앱 코드가 아니라 여기인가: `NEXT_PUBLIC_*` 시드를 앱에 두면 값을 주지 않아도
 * **프로덕션 번들에 그 분기가 그대로 실린다**(실측: `t(7074).env.NEXT_PUBLIC_AFC_TEST_TODAY` 가
 * 클라이언트 청크에 남았다). 테스트 편의를 위해 배포 산출물에 경로를 남기지 않는다.
 *
 * 왜 `setFixedTime` 이 아니라 `install` + `resume` 인가: 휴식 타이머가 `Date.now()` **델타**로
 * 남은 시간을 계산한다. 시간을 얼리면 카운트다운이 멈춰 "실제 시간이 지나면 줄어든다" 스펙이 죽는다.
 * `resume()` 은 날짜만 옮기고 시간은 실제로 흐르게 한다(실측: 1,200ms 대기 → 1,207ms 경과).
 */
import { test as base, expect } from "@playwright/test";
import { TEST_NOW } from "./test-today";

export const test = base.extend({
  // 두 번째 인자는 관례상 `use` 지만 **위치 인자**다. `use` 로 두면 react-hooks 규칙이
  // React 훅 호출로 오인해 lint 가 깨진다(apps/web 전체에 훅 규칙이 켜져 있다).
  context: async ({ context }, runTest) => {
    await context.clock.install({ time: new Date(TEST_NOW) });
    await context.clock.resume();
    await runTest(context);
  },
});

export { expect };

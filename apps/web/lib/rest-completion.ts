/**
 * 휴식 완료 게이트 — **하나의 관측, 하나의 싱크.**
 *
 * 종료를 알리는 길이 둘이다: 전경이면 비프·진동(`rest-feedback`), 실제로 숨어 있으면
 * best-effort SW 알림(`rest-notification`). 둘을 각자 게이트하면 같은 종료를 두 장부가 보고,
 * 실측으로 두 가지가 깨졌다.
 *
 *  ① **복귀 후 늦은 알림.** 알림 쪽 게이트에는 "언제 끝났는가"가 없어서, 숨은 채로 복구된
 *     만료 타이머가 지난 세션의 휴식에 대해 알림을 띄웠다.
 *  ② **정체성이 `endsAt` 뿐**이라 세션·세트가 달라도 같은 밀리초면 한 휴식으로 봤다.
 *
 * 그래서 정체성을 `{sessionId, plannedSetId, endsAt}` 로 잡고, 한 관측을 정확히 한 싱크가 소비한다.
 *
 * **한 번만이어야 하는 이유는 종료가 이벤트가 아니라 상태이기 때문이다.** 남은 시간은 200ms 틱과
 * `visibilitychange`·`focus`·`pageshow` 에서 다시 계산되고 StrictMode 는 이펙트를 두 번 돌린다.
 * 그때마다 "0 이다"가 참이므로, 관측 횟수로 울리면 한 번의 휴식이 여러 번 울린다.
 */

export type RestCompletionObservation = {
  finished: boolean;
  /** 이 휴식이 속한 세션. 세션이 다르면 다른 휴식이다. */
  sessionId: string;
  /** 이 휴식을 만든 세트. 같은 밀리초에 끝나도 세트가 다르면 다른 휴식이다. */
  plannedSetId: string;
  /** 끝나는 시각(epoch ms). 연장하면 새 값이 되고 그건 새 휴식이다. */
  endsAt: number;
  /**
   * 페이지가 **마지막으로 전경이 된** 시각(epoch ms). 지금 숨어 있으면 `null`.
   *
   * 관측 순간의 `visibilityState` 만으로는 부족하다 — 탭이 숨으면 타이머 틱이 스로틀돼서,
   * 백그라운드에서 끝난 휴식도 **복귀 직후에 처음** 관측된다. 그때 "지금 보인다"만 보면
   * 늦은 비프가 그대로 울린다. 끝난 시각이 전경 복귀보다 앞서는지 비교해야 구분된다.
   */
  visibleSince: number | null;
};

export type RestCompletionSinks = {
  /** 전경에서 끝났을 때. 비프·진동. */
  emitForeground: () => void;
  /** 실제로 숨어 있을 때. best-effort 알림(성공 여부는 모듈이 스스로 판단한다). */
  notifyHidden: () => void | Promise<unknown>;
};

export type RestCompletionGate = (observation: RestCompletionObservation) => void;

/**
 * 정체성 키. **조각을 그냥 이어붙이지 않는다** — `"s-a" + "ps-1"` 과 `"s-a|ps" + "-1"` 이
 * 같은 키가 되면 서로 다른 휴식 하나가 조용히 삼켜진다. 길이를 앞에 붙여 경계를 못박는다.
 */
function identityOf({ sessionId, plannedSetId, endsAt }: RestCompletionObservation): string {
  return `${sessionId.length}:${sessionId}|${plannedSetId.length}:${plannedSetId}|${endsAt}`;
}

/**
 * 관측을 받아 **정확히 한 싱크**로 보낸다.
 *
 * 억제하는 경우에도 정체성은 **먼저 소비한다.** 남겨 두면 다음 관측에서 늦게 울려
 * "백그라운드에서 끝난 휴식을 복귀 시 재생하지 않는다"가 깨진다.
 *
 * 장부는 이 클로저가 갖는다. 시트가 아니라 **세션 화면**이 이걸 들고 있어야 한다 —
 * 시트는 휴식마다 마운트/언마운트돼서 그 안에 두면 장부가 휴식보다 먼저 죽는다.
 */
export function createRestCompletionGate(sinks: RestCompletionSinks): RestCompletionGate {
  const consumed = new Set<string>();

  return (observation) => {
    if (!observation.finished) return;

    const identity = identityOf(observation);
    if (consumed.has(identity)) return;
    consumed.add(identity);

    const { visibleSince, endsAt } = observation;

    // 지금 숨어 있다 → 알림의 몫이다.
    if (visibleSince === null) {
      void runSafely(() => sinks.notifyHidden());
      return;
    }

    // 복귀보다 앞서 끝났다 → 이미 지난 일이다. 늦게 재생하지 않는다.
    if (endsAt < visibleSince) return;

    // 보는 중에 끝났다 → 비프·진동의 몫이다.
    void runSafely(() => sinks.emitForeground());
  };
}

/**
 * 싱크의 실패가 게이트를 막지 못하게 한다. 부가 신호가 던져서 다음 휴식의 판정이 사라지면
 * 부가 기능이 본 기능을 인질로 잡는 셈이다.
 */
function runSafely(run: () => void | Promise<unknown>): void {
  try {
    const result = run();
    if (result instanceof Promise) result.catch(() => {});
  } catch {
    // 신호 없이 지나간다.
  }
}

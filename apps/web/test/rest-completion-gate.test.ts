/**
 * **휴식 완료 게이트는 하나다.**
 *
 * T1(비프·진동)과 T2(SW 알림)를 각자 병합하면 같은 종료를 **두 장부**가 본다. 그러면 두 가지가 깨진다.
 *
 * ① 복귀 후 늦은 알림 — T2 게이트에는 "언제 끝났는가"가 없어서, 숨은 채로 복구된 만료 타이머가
 *    지난 세션의 휴식에 대해 알림을 띄운다.
 * ② 정체성이 `endsAt` 뿐이라 세션·세트가 달라도 같은 밀리초면 한 휴식으로 본다.
 *
 * 그래서 정체성을 `{sessionId, plannedSetId, endsAt}` 로 잡고, 한 관측을 **정확히 한 싱크**가 소비한다.
 * 그리고 종료가 신호가 되려면 **그 정체성의 진행 중을 본 적이 있어야** 한다(arm).
 */
import { describe, expect, it, vi } from "vitest";
import { createRestCompletionGate } from "../lib/rest-completion";

const T0 = 1_700_000_000_000;
const SESSION = "s-a";
const SET = "ps-1";

/** 전경에서 끝난 관측. `visibleSince` 가 종료보다 앞이면 보는 중에 끝난 것이다. */
const ended = (overrides: Record<string, unknown> = {}) => ({
  finished: true,
  sessionId: SESSION,
  plannedSetId: SET,
  endsAt: T0 + 90_000,
  visibleSince: T0,
  ...overrides,
});

function gate() {
  const beep = vi.fn();
  const notify = vi.fn();
  const observe = createRestCompletionGate({ emitForeground: beep, notifyHidden: notify });

  return {
    beep,
    notify,
    observe,
    /**
     * 그 정체성의 **진행 중**을 한 번 관측한다. 실제 화면에서는 시트가 열리는 순간부터
     * 200ms 마다 이 관측이 온다 — 종료는 그 뒤에 온다.
     */
    arm: (overrides: Record<string, unknown> = {}) =>
      observe(ended({ finished: false, ...overrides })),
  };
}

describe("배타 디스패치 — 한 관측은 한 싱크만 소비한다", () => {
  it("전경에서 끝나면 **비프만** 한 번, 알림은 0", () => {
    const { beep, notify, observe, arm } = gate();

    arm();
    observe(ended());

    expect(beep).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("실제로 숨어 있을 때 끝나면 **알림만** 한 번, 비프는 0", () => {
    const { beep, notify, observe, arm } = gate();

    arm();
    // 숨으면 전경 시각을 잊는다 — `visibleSince === null` 이 곧 "지금 숨음"이다.
    observe(ended({ visibleSince: null }));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(beep).not.toHaveBeenCalled();
  });

  it("백그라운드에서 끝난 뒤 복귀하면 **둘 다 0** — 늦은 재생이 없다", () => {
    const { beep, notify, observe, arm } = gate();

    arm({ endsAt: T0 + 10_000 });
    // 복귀 직후 처음 관측한다. 끝난 시각이 전경 복귀보다 앞선다.
    observe(ended({ endsAt: T0 + 10_000, visibleSince: T0 + 50_000 }));

    expect(beep).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("아직 끝나지 않았으면 **그 자리에서 울리지 않는다**", () => {
    const { beep, notify, arm } = gate();

    // 진행 중 관측이 여러 번 온다(200ms 틱).
    arm();
    arm();

    expect(beep).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("진행 중 관측은 **정체성을 소비하지 않는다** — 뒤이은 종료가 정상적으로 울린다", () => {
    const { beep, observe, arm } = gate();

    arm();
    observe(ended());

    expect(beep).toHaveBeenCalledTimes(1);
  });
});

/**
 * **arm 없이는 fan-out 하지 않는다.**
 *
 * 게이트가 첫 관측만 보면 "지금 돌던 휴식이 방금 끝났다"와 "앱을 다시 열었더니 저장소의 타이머가
 * 이미 만료돼 있었다"를 구분할 수 없다. 후자에 알림을 보내면 **지난 세션의 휴식에 대해 새 알림**이
 * 뜬다. 시간 규칙(`endsAt < visibleSince`)으로는 못 막는다 — 숨은 채 복구되면 `visibleSince` 가
 * `null` 이라 그 비교에 닿지도 못한다.
 */
describe("arm — 진행 중을 본 적 있어야 종료가 신호가 된다", () => {
  it("**첫 관측부터 끝나 있으면 숨김이어도 알림 0** — 복구된 과거 타이머", () => {
    const { beep, notify, observe } = gate();

    observe(ended({ visibleSince: null }));

    expect(notify).not.toHaveBeenCalled();
    expect(beep).not.toHaveBeenCalled();
  });

  it("첫 관측부터 끝나 있으면 전경이어도 비프 0", () => {
    const { beep, notify, observe } = gate();

    observe(ended());

    expect(beep).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("arm 되지 않은 정체성은 **소비된다** — 그 뒤 전경·숨김 어느 쪽으로도 늦게 울리지 않는다", () => {
    const { beep, notify, observe } = gate();

    observe(ended({ visibleSince: null })); // 숨은 채 복구
    observe(ended({ visibleSince: T0 })); // 복귀 후 틱
    observe(ended({ visibleSince: null })); // 다시 숨음

    expect(beep).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("소비된 뒤에는 **진행 중 관측으로도 다시 장전되지 않는다**", () => {
    const { beep, observe, arm } = gate();

    observe(ended()); // arm 없는 종료 → 소비
    arm(); // 뒤늦은 진행 중 관측
    observe(ended()); // 같은 정체성의 종료

    expect(beep).not.toHaveBeenCalled();
  });

  it("**진짜 숨김 만료**는 알림 1회 — 진행 중을 먼저 본 뒤 숨은 채 끝난다", () => {
    const { beep, notify, observe, arm } = gate();

    arm({ visibleSince: T0 }); // 보는 중 진행
    arm({ visibleSince: null }); // 숨었고 아직 진행 중
    observe(ended({ visibleSince: null })); // 숨은 채 끝났다

    expect(notify).toHaveBeenCalledTimes(1);
    expect(beep).not.toHaveBeenCalled();
  });

  it("**전경 만료**는 비프 1회 — 같은 arm 규칙을 지난다", () => {
    const { beep, notify, observe, arm } = gate();

    arm();
    observe(ended());

    expect(beep).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("arm 은 정체성별이다 — 다른 세트를 arm 해도 이 세트가 열리지 않는다", () => {
    const { beep, observe, arm } = gate();

    arm({ plannedSetId: "ps-1" });
    observe(ended({ plannedSetId: "ps-2" })); // arm 된 적 없다

    expect(beep).not.toHaveBeenCalled();
  });

  it("새 정체성은 다시 arm 할 수 있다 — 억제가 게이트를 영구히 닫지 않는다", () => {
    const { beep, observe, arm } = gate();

    observe(ended({ visibleSince: null })); // arm 없는 복구 → 억제·소비
    arm({ endsAt: T0 + 120_000 });
    observe(ended({ endsAt: T0 + 120_000 }));

    expect(beep).toHaveBeenCalledTimes(1);
  });
});

describe("정확히 한 번 — 중복 관측", () => {
  it("틱·visibilitychange·focus·pageshow·StrictMode 재실행에도 1회", () => {
    const { beep, notify, observe, arm } = gate();
    const seen = ended();

    arm();
    observe(seen); // 종료 감지
    observe(seen); // 200ms 틱
    observe(seen); // visibilitychange
    observe(seen); // focus
    observe(seen); // pageshow
    observe(seen); // StrictMode 이펙트 재실행

    expect(beep).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("억제한 관측도 정체성을 **소비한다** — 뒤늦게 전경이 돼도 울리지 않는다", () => {
    const { beep, notify, observe, arm } = gate();

    arm({ endsAt: T0 + 10_000 });
    // 복귀 전에 끝났다 → 억제.
    observe(ended({ endsAt: T0 + 10_000, visibleSince: T0 + 50_000 }));
    // 그 뒤 같은 휴식을 전경에서 다시 관측한다(틱). 남아 있었다면 여기서 울린다.
    observe(ended({ endsAt: T0 + 10_000, visibleSince: T0 }));

    expect(beep).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("숨김에서 알린 뒤 복귀해서 다시 관측해도 비프가 없다 — 싱크를 갈아타지 않는다", () => {
    const { beep, notify, observe, arm } = gate();

    arm();
    observe(ended({ visibleSince: null }));
    observe(ended({ visibleSince: T0 }));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(beep).not.toHaveBeenCalled();
  });
});

describe("정체성 — {sessionId, plannedSetId, endsAt}", () => {
  it("**endsAt 이 같아도 세트가 다르면** 각각 한 번씩", () => {
    const { beep, observe, arm } = gate();

    arm({ plannedSetId: "ps-1" });
    arm({ plannedSetId: "ps-2" });
    observe(ended({ plannedSetId: "ps-1" }));
    observe(ended({ plannedSetId: "ps-2" }));

    expect(beep).toHaveBeenCalledTimes(2);
  });

  it("**endsAt·세트가 같아도 세션이 다르면** 각각 한 번씩", () => {
    const { beep, observe, arm } = gate();

    arm({ sessionId: "s-a" });
    arm({ sessionId: "s-b" });
    observe(ended({ sessionId: "s-a" }));
    observe(ended({ sessionId: "s-b" }));

    expect(beep).toHaveBeenCalledTimes(2);
  });

  it("**억제가 영구가 아니다** — 복귀 뒤 시작한 다음 휴식은 정상적으로 울린다", () => {
    const { beep, notify, observe, arm } = gate();
    const backAt = T0 + 50_000;

    // 백그라운드에서 끝난 휴식 → 억제.
    arm({ endsAt: T0 + 10_000 });
    observe(ended({ endsAt: T0 + 10_000, visibleSince: backAt }));
    // 복귀 뒤 시작한 다음 세트의 휴식.
    arm({ plannedSetId: "ps-2", endsAt: backAt + 90_000, visibleSince: backAt });
    observe(ended({ plannedSetId: "ps-2", endsAt: backAt + 90_000, visibleSince: backAt }));

    expect(beep).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("휴식을 더하면(새 endsAt) 재arm 된다", () => {
    const { beep, observe, arm } = gate();

    arm();
    observe(ended());
    arm({ endsAt: T0 + 120_000 });
    observe(ended({ endsAt: T0 + 120_000 }));

    expect(beep).toHaveBeenCalledTimes(2);
  });

  it("정체성 조각이 문자열 이어붙이기로 섞이지 않는다", () => {
    const { beep, observe, arm } = gate();

    // "s-a|ps-1" 과 "s-a|ps" + "-1" 이 같은 키가 되면 두 번째가 삼켜진다.
    arm({ sessionId: "s-a", plannedSetId: "ps-1" });
    arm({ sessionId: "s-a|ps", plannedSetId: "-1" });
    observe(ended({ sessionId: "s-a", plannedSetId: "ps-1" }));
    observe(ended({ sessionId: "s-a|ps", plannedSetId: "-1" }));

    expect(beep).toHaveBeenCalledTimes(2);
  });

  it("장부는 관측 순서와 무관하게 정체성별로 독립이다", () => {
    const { beep, observe, arm } = gate();

    arm({ plannedSetId: "ps-1" });
    arm({ plannedSetId: "ps-2" });
    observe(ended({ plannedSetId: "ps-1" }));
    observe(ended({ plannedSetId: "ps-2" }));
    observe(ended({ plannedSetId: "ps-1" })); // 이미 소비됨
    observe(ended({ plannedSetId: "ps-2" })); // 이미 소비됨

    expect(beep).toHaveBeenCalledTimes(2);
  });
});

describe("싱크 실패는 게이트를 막지 않는다", () => {
  it("비프가 던져도 정체성은 소비되고 다음 휴식이 산다", () => {
    const beep = vi.fn(() => {
      throw new Error("audio failed");
    });
    const notify = vi.fn();
    const observe = createRestCompletionGate({ emitForeground: beep, notifyHidden: notify });

    observe(ended({ finished: false }));
    expect(() => observe(ended())).not.toThrow();
    observe(ended()); // 같은 정체성 — 늘지 않는다
    expect(beep).toHaveBeenCalledTimes(1);

    observe(ended({ finished: false, endsAt: T0 + 120_000 }));
    observe(ended({ endsAt: T0 + 120_000 }));
    expect(beep).toHaveBeenCalledTimes(2);
  });

  it("알림이 거부(reject)돼도 위로 새지 않는다", async () => {
    const notify = vi.fn(() => Promise.reject(new Error("no permission")));
    const observe = createRestCompletionGate({ emitForeground: vi.fn(), notifyHidden: notify });

    observe(ended({ finished: false, visibleSince: null }));
    expect(() => observe(ended({ visibleSince: null }))).not.toThrow();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

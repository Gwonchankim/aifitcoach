/**
 * 휴식 종료 피드백(비프·진동) 계약.
 *
 * 소리와 진동은 **부가 기능**이다. 미지원·거부·중단 어느 경우에도 세트 완료·기록·다음 세트 UI를
 * 막으면 안 된다 — 그래서 여기 단언의 절반은 "무엇을 하는가"가 아니라 **"무엇을 못 막는가"** 다.
 *
 * 이 저장소에는 jsdom 이 없다. 그래서 기존 컨벤션(`rest-timer.ts` + `RestTimerSheet.tsx`)대로
 * 판정을 순수 함수로 분리해 호출 순서를 직접 재생하고, 화면 보존은 `react-dom/server` 로 본다.
 * 브라우저 API 는 전부 `globalThis` 에서 **호출 시점에** 읽으므로 node 환경에서 그대로 검증된다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestTimerSheet } from "../components/session/RestTimerSheet";
import { startRest } from "../lib/rest-timer";

const T0 = 1_700_000_000_000;

/** 모듈이 AudioContext 를 lazy singleton 으로 잡으므로 테스트마다 새로 import 한다. */
async function freshModule() {
  vi.resetModules();
  return import("../lib/rest-feedback");
}

type OscillatorStub = {
  frequency: { value: number };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

/** 최소 AudioContext 대역. `state` 를 바꿔 autoplay 정책 상황을 만든다. */
function audioStub(state: "running" | "suspended" = "running") {
  const oscillator: OscillatorStub = {
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = { gain: { value: 0 }, connect: vi.fn() };
  const resume = vi.fn(() => Promise.resolve());
  const created: unknown[] = [];
  const context = {
    state,
    currentTime: 10,
    destination: { id: "dest" },
    createOscillator: vi.fn(() => oscillator),
    createGain: vi.fn(() => gain),
    resume,
  };
  class FakeAudioContext {
    constructor() {
      created.push(this);
      return context as unknown as FakeAudioContext;
    }
  }
  return { FakeAudioContext, context, oscillator, gain, resume, created };
}

const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");

function setAudioContext(value: unknown) {
  Object.defineProperty(globalThis, "AudioContext", {
    value,
    configurable: true,
    writable: true,
  });
}

function setVibrate(value: unknown) {
  Object.defineProperty(globalThis.navigator, "vibrate", {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  setAudioContext(undefined);
  setVibrate(undefined);
});

afterEach(() => {
  if (originalAudio) Object.defineProperty(globalThis, "AudioContext", originalAudio);
  else Reflect.deleteProperty(globalThis, "AudioContext");
  Reflect.deleteProperty(globalThis.navigator, "vibrate");
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 보존: 기존 타이머 화면 계약은 이 티켓에서 바뀌지 않는다.
 * ------------------------------------------------------------------ */

describe("보존 — 0 클램프와 '휴식 완료' 화면", () => {
  const sheet = (elapsedMs: number) => {
    vi.spyOn(Date, "now").mockReturnValue(T0 + elapsedMs);
    return renderToStaticMarkup(
      createElement(RestTimerSheet, {
        open: true,
        title: "벤치프레스 1세트 후 휴식",
        timer: startRest(90, T0),
        onChange: () => {},
        onClose: () => {},
        onCompletionObserved: () => {},
      }),
    );
  };

  it("종료해도 시트가 그대로 열려 있다 — 자동으로 닫지 않는다(§4.7)", () => {
    const markup = sheet(90_000);
    expect(markup).toContain("휴식 완료");
    // 시트가 살아 있다는 증거: 제목과 CTA 가 여전히 DOM 에 있다.
    expect(markup).toContain("벤치프레스 1세트 후 휴식");
    expect(markup).toContain("다음 세트");
  });

  it("시간이 더 지나도 0:00 에서 멈춘다 — 카운트업 금지", () => {
    expect(sheet(90_000)).toContain("0:00");
    expect(sheet(600_000)).toContain("0:00");
  });

  it("진행 중에는 종료 문구가 없다", () => {
    const markup = sheet(30_000);
    expect(markup).toContain("남은 휴식 시간");
    expect(markup).not.toContain("휴식 완료");
  });
});

/* ------------------------------------------------------------------ *
 * unlock — 사용자 제스처에서 한 번.
 * ------------------------------------------------------------------ */

describe("unlock — 사용자 제스처에서 컨텍스트를 연다", () => {
  it("여러 번 불려도 AudioContext 는 하나만 만든다", async () => {
    const { FakeAudioContext, created } = audioStub();
    setAudioContext(FakeAudioContext);
    const { unlockRestFeedback } = await freshModule();

    unlockRestFeedback();
    unlockRestFeedback();
    unlockRestFeedback();

    expect(created).toHaveLength(1);
  });

  it("suspended 면 resume 을 시도한다", async () => {
    const { FakeAudioContext, resume } = audioStub("suspended");
    setAudioContext(FakeAudioContext);
    const { unlockRestFeedback } = await freshModule();

    unlockRestFeedback();

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("running 이면 resume 을 부르지 않는다", async () => {
    const { FakeAudioContext, resume } = audioStub("running");
    setAudioContext(FakeAudioContext);
    const { unlockRestFeedback } = await freshModule();

    unlockRestFeedback();

    expect(resume).not.toHaveBeenCalled();
  });

  it("AudioContext 자체가 없으면 조용히 지나간다(SSR·미지원 브라우저)", async () => {
    const { unlockRestFeedback } = await freshModule();
    expect(() => unlockRestFeedback()).not.toThrow();
  });

  it("AudioContext 를 **읽는 것만으로** 던져도 삼킨다", async () => {
    const { unlockRestFeedback } = await freshModule();
    // 일부 정책·확장 프로그램은 접근 자체를 막는다. 조회가 try 밖에 있으면 여기서 새어 나간다.
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });

    expect(() => unlockRestFeedback()).not.toThrow();
  });

  it("생성자가 던져도 삼킨다", async () => {
    setAudioContext(
      class {
        constructor() {
          throw new Error("NotAllowedError");
        }
      },
    );
    const { unlockRestFeedback } = await freshModule();

    expect(() => unlockRestFeedback()).not.toThrow();
  });

  it("resume 이 거부돼도 unhandled rejection 을 만들지 않는다", async () => {
    const stub = audioStub("suspended");
    stub.resume.mockReturnValue(Promise.reject(new Error("denied")));
    setAudioContext(stub.FakeAudioContext);
    const { unlockRestFeedback } = await freshModule();

    expect(() => unlockRestFeedback()).not.toThrow();
    await Promise.resolve();
  });
});

/* ------------------------------------------------------------------ *
 * emit — 비프와 진동. 상수는 정확히 고정한다.
 * ------------------------------------------------------------------ */

describe("emit — 비프", () => {
  it("unlock 한 컨텍스트로 고정된 음색·길이를 낸다", async () => {
    const { FakeAudioContext, context, oscillator, gain } = audioStub();
    setAudioContext(FakeAudioContext);
    const { unlockRestFeedback, emitRestCompleteFeedback, REST_BEEP } = await freshModule();

    unlockRestFeedback();
    emitRestCompleteFeedback();

    // 상수는 단일 원천이고, 이 테스트가 그 값을 정확히 못박는다.
    expect(REST_BEEP).toEqual({ frequencyHz: 880, durationMs: 120, gain: 0.06 });
    expect(oscillator.frequency.value).toBe(880);
    expect(gain.gain.value).toBe(0.06);
    expect(oscillator.start).toHaveBeenCalledTimes(1);
    // 0.12초 뒤 정확히 멈춘다 — 길게 끌면 침습적이다.
    expect(oscillator.stop).toHaveBeenCalledWith(context.currentTime + 0.12);
    expect(oscillator.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
  });

  it("**suspended 면 음원을 만들지 않는다** — resume 이 거부된 뒤 종료를 관측해도 0개", async () => {
    const stub = audioStub("suspended");
    stub.resume.mockImplementation(() => Promise.reject(new Error("NotAllowedError")));
    setAudioContext(stub.FakeAudioContext);
    const { unlockRestFeedback, emitRestCompleteFeedback } = await freshModule();

    unlockRestFeedback(); // 제스처에서 열었지만 resume 이 거부됐다
    await Promise.resolve();
    emitRestCompleteFeedback(); // 타이머 종료

    expect(stub.context.createOscillator).not.toHaveBeenCalled();
    expect(stub.oscillator.start).not.toHaveBeenCalled();
  });

  it("**나중에 resume 에 성공해도 지난 비프가 되살아나지 않는다** — 늦은 재생 금지", async () => {
    const stub = audioStub("suspended");
    stub.resume.mockImplementation(() => Promise.reject(new Error("NotAllowedError")));
    setAudioContext(stub.FakeAudioContext);
    const { unlockRestFeedback, emitRestCompleteFeedback } = await freshModule();

    // 1) 제스처 → resume 거부. 2) 1세트 휴식 종료 관측.
    unlockRestFeedback();
    await Promise.resolve();
    emitRestCompleteFeedback();

    // 3) 다음 세트 완료 제스처에서 resume 이 성공한다.
    stub.resume.mockImplementation(() => Promise.resolve());
    stub.context.state = "running";
    unlockRestFeedback();
    await Promise.resolve();

    // suspended 동안 **예약된 source 가 없어야** 지난 휴식의 비프가 지금 울리지 않는다.
    expect(stub.context.createOscillator).not.toHaveBeenCalled();
    expect(stub.oscillator.start).not.toHaveBeenCalled();

    // 그리고 지금 휴식이 끝나면 정상적으로 한 번 울린다 — 기능이 죽은 게 아니다.
    emitRestCompleteFeedback();
    expect(stub.oscillator.start).toHaveBeenCalledTimes(1);
  });

  it("진동은 suspended 와 무관하게 울린다 — 오디오 정책이 진동을 막지 않는다", async () => {
    const stub = audioStub("suspended");
    setAudioContext(stub.FakeAudioContext);
    const vibrate = vi.fn(() => true);
    setVibrate(vibrate);
    const { unlockRestFeedback, emitRestCompleteFeedback } = await freshModule();

    unlockRestFeedback();
    emitRestCompleteFeedback();

    expect(stub.context.createOscillator).not.toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("unlock 하지 않았으면 소리를 만들지 않는다 — 그래도 던지지 않는다", async () => {
    const { FakeAudioContext, context } = audioStub();
    setAudioContext(FakeAudioContext);
    const { emitRestCompleteFeedback } = await freshModule();

    expect(() => emitRestCompleteFeedback()).not.toThrow();
    expect(context.createOscillator).not.toHaveBeenCalled();
  });

  it("오디오 노드 생성이 던져도 삼킨다", async () => {
    const stub = audioStub();
    stub.context.createOscillator.mockImplementation(() => {
      throw new Error("InvalidStateError");
    });
    setAudioContext(stub.FakeAudioContext);
    const { unlockRestFeedback, emitRestCompleteFeedback } = await freshModule();

    unlockRestFeedback();
    expect(() => emitRestCompleteFeedback()).not.toThrow();
  });
});

describe("emit — 진동", () => {
  it("고정된 패턴으로 한 번 울린다", async () => {
    const vibrate = vi.fn(() => true);
    setVibrate(vibrate);
    const { emitRestCompleteFeedback, REST_VIBRATE_PATTERN_MS } = await freshModule();

    emitRestCompleteFeedback();

    expect(REST_VIBRATE_PATTERN_MS).toEqual([120]);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith([120]);
  });

  it("호출부에 넘긴 배열을 바꿔도 상수는 오염되지 않는다", async () => {
    const captured: number[][] = [];
    setVibrate(
      vi.fn((pattern: number[]) => {
        captured.push(pattern);
        pattern[0] = 9999;
        return true;
      }),
    );
    const { emitRestCompleteFeedback, REST_VIBRATE_PATTERN_MS } = await freshModule();

    emitRestCompleteFeedback();

    expect(captured[0][0]).toBe(9999);
    expect(REST_VIBRATE_PATTERN_MS).toEqual([120]);
  });

  it("vibrate 가 없으면 조용히 지나간다(iOS·데스크톱)", async () => {
    const { emitRestCompleteFeedback } = await freshModule();
    expect(() => emitRestCompleteFeedback()).not.toThrow();
  });

  it("vibrate 가 던져도(권한 거부) 삼킨다", async () => {
    setVibrate(
      vi.fn(() => {
        throw new Error("NotAllowedError");
      }),
    );
    const { emitRestCompleteFeedback } = await freshModule();

    expect(() => emitRestCompleteFeedback()).not.toThrow();
  });
});

describe("emit — 한쪽 실패가 다른 쪽을 막지 않는다", () => {
  it("비프가 던져도 진동은 울린다", async () => {
    const stub = audioStub();
    stub.context.createOscillator.mockImplementation(() => {
      throw new Error("boom");
    });
    setAudioContext(stub.FakeAudioContext);
    const vibrate = vi.fn(() => true);
    setVibrate(vibrate);
    const { unlockRestFeedback, emitRestCompleteFeedback } = await freshModule();

    unlockRestFeedback();
    emitRestCompleteFeedback();

    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("진동이 던져도 비프는 이미 났다", async () => {
    const stub = audioStub();
    setAudioContext(stub.FakeAudioContext);
    setVibrate(
      vi.fn(() => {
        throw new Error("boom");
      }),
    );
    const { unlockRestFeedback, emitRestCompleteFeedback } = await freshModule();

    unlockRestFeedback();
    emitRestCompleteFeedback();

    expect(stub.oscillator.start).toHaveBeenCalledTimes(1);
  });

  it("둘 다 미지원이어도 호출은 성공한다 — 기록 흐름을 막지 않는다", async () => {
    const { emitRestCompleteFeedback } = await freshModule();
    expect(() => emitRestCompleteFeedback()).not.toThrow();
  });
});

describe("모듈 로드", () => {
  it("import 만으로는 브라우저 API 를 건드리지 않는다(SSR 안전)", async () => {
    // AudioContext 를 접근 즉시 던지는 getter 로 바꿔 두고 import 한다.
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      get() {
        throw new Error("모듈 로드 중 AudioContext 를 읽었다");
      },
    });

    await expect(freshModule()).resolves.toBeDefined();
  });
});

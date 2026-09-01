/**
 * 휴식 종료 피드백(비프·진동).
 *
 * 화면을 보고 있지 않아도 세트가 끝난 걸 알게 하는 **부가 신호**다. 그래서 이 파일의 규칙은 하나다 —
 * **어떤 실패도 위로 새지 않는다.** 미지원 브라우저, 권한 거부, autoplay 정책으로 멈춘 컨텍스트가
 * 세트 완료·기록 저장·다음 세트 UI 를 막으면 부가 기능이 본 기능을 인질로 잡는 셈이다.
 *
 * 브라우저 API 는 전부 **호출 시점에** `globalThis` 에서 읽는다. 모듈을 불러오는 것만으로는
 * 아무것도 건드리지 않으므로 서버 렌더에서 안전하다.
 *
 * `webkitAudioContext` 폴백은 두지 않는다 — 실기기에서만 도는 분기는 테스트가 영원히 못 잡는다
 * (CLAUDE.md 함정 1). Safari 는 14.1 부터 접두사 없는 `AudioContext` 를 지원한다.
 */

/** 종료 신호음. 짧고 낮게 — 헬스장에서 거슬리지 않아야 한다. */
export const REST_BEEP = { frequencyHz: 880, durationMs: 120, gain: 0.06 } as const;

/** 종료 진동 패턴(ms). 비프와 같은 길이로 한 번만 울린다. */
export const REST_VIBRATE_PATTERN_MS: readonly number[] = [120];

/**
 * 사용자 제스처에서 연 컨텍스트. autoplay 정책상 제스처 밖에서 만들면 `suspended` 로 태어나
 * 소리가 나지 않으므로 **세트 완료 제스처에서 한 번** 열고 계속 쓴다.
 */
let context: AudioContext | null = null;

function audioContextCtor(): typeof AudioContext | null {
  return typeof globalThis.AudioContext === "function" ? globalThis.AudioContext : null;
}

/**
 * 사용자 제스처 안에서 호출한다(세트 완료 → 첫 휴식 타이머 시작).
 * 두 번째 호출부터는 아무 일도 하지 않는다.
 */
export function unlockRestFeedback(): void {
  try {
    // 조회까지 try 안이다 — `globalThis.AudioContext` 는 접근만으로 던질 수 있다(정책·확장 프로그램).
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    context ??= new Ctor();
    // 탭 복귀 등으로 멈춰 있으면 깨워 둔다. 거부되더라도 조용히 무음으로 떨어질 뿐이다.
    if (context.state === "suspended") context.resume().catch(() => {});
  } catch {
    context = null;
  }
}

function beep(): void {
  if (!context) return;
  try {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = REST_BEEP.frequencyHz;
    gain.gain.value = REST_BEEP.gain;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + REST_BEEP.durationMs / 1000);
  } catch {
    // 무음으로 떨어진다.
  }
}

function vibrate(): void {
  const { navigator } = globalThis;
  if (typeof navigator?.vibrate !== "function") return;
  try {
    // 복사본을 넘긴다 — 브라우저가 인자를 보관해도 우리 상수가 바뀌지 않는다.
    navigator.vibrate([...REST_VIBRATE_PATTERN_MS]);
  } catch {
    // 진동 없이 지나간다.
  }
}

/**
 * 종료를 알린다. 비프와 진동은 **서로 독립**이다 — 한쪽이 던져도 다른 쪽은 실행된다.
 * 호출 횟수 제어는 이 함수가 아니라 `createRestCompletionSignal` 이 한다.
 */
export function emitRestCompleteFeedback(): void {
  beep();
  vibrate();
}

export type RestCompletionSignal = (finished: boolean, endsAt: number) => void;

/**
 * **타이머 하나당 한 번만** 내보내는 게이트.
 *
 * 이게 필요한 이유는 종료가 이벤트가 아니라 **상태**이기 때문이다. 남은 시간은 200ms 틱과
 * `visibilitychange`·`focus`·`pageshow` 에서 다시 계산되고 StrictMode 는 이펙트를 두 번 돌린다.
 * 그때마다 "0 이다"가 참이므로, 관측 횟수로 울리면 한 번의 휴식이 여러 번 울린다.
 *
 * 그래서 **끝난 시각(`endsAt`)을 타이머의 정체성으로 삼는다.** 같은 값이면 이미 알린 그 휴식이고,
 * 휴식을 더하거나(새 `endsAt`) 다음 세트로 넘어가면 다른 휴식이다.
 */
export function createRestCompletionSignal(emit: () => void): RestCompletionSignal {
  let signaledEndsAt: number | null = null;

  return (finished, endsAt) => {
    if (!finished || signaledEndsAt === endsAt) return;
    signaledEndsAt = endsAt;
    emit();
  };
}

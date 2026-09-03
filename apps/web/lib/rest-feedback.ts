/**
 * 휴식 종료 피드백(비프·진동).
 *
 * 화면을 **보고는 있지만** 타이머를 주시하지 않는 사람에게 종료를 알리는 **부가 신호**다.
 * 앱이 전경에 있을 때만 울린다 — 백그라운드에서 끝난 휴식을 복귀 시점에 늦게 재생하지 않는다
 * (UX_STATES §4.7 "알림 조건"). **언제 울릴지는 이 파일이 정하지 않는다** — `lib/rest-completion.ts`
 * 의 게이트가 하나의 관측을 보고 이 싱크와 OS 알림 중 **하나만** 고른다.
 *
 * 그래서 이 파일의 규칙은 하나다 — **어떤 실패도 위로 새지 않는다.** 미지원 브라우저, 권한 거부,
 * autoplay 정책으로 멈춘 컨텍스트가 세트 완료·기록 저장·다음 세트 UI 를 막으면
 * 부가 기능이 본 기능을 인질로 잡는 셈이다.
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
  // **`running` 이 아니면 아무것도 만들지 않는다.** suspended 컨텍스트는 렌더링 시간이 흐르지 않아
  // 여기서 예약한 source 가 **지금 소리 나지 않고 다음 resume 때 울린다** — 다음 세트를 시작하는
  // 순간에 지난 휴식의 비프가 나온다. "종료 시 한 번"이라는 시간 의미가 깨지므로 무음으로 떨어진다.
  if (!context || context.state !== "running") return;
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
 * 호출 횟수 제어는 이 함수가 아니라 `lib/rest-completion.ts` 의 게이트가 한다.
 */
export function emitRestCompleteFeedback(): void {
  beep();
  vibrate();
}

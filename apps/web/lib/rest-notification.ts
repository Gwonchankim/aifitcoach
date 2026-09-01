/**
 * 휴식 종료 **best-effort** 알림.
 *
 * 이건 OS 예약 알람이 아니다. 페이지가 살아 있고 숨겨져 있을 때만, 이미 받아 둔 권한으로
 * 한 번 띄우는 것뿐이다. 브라우저가 백그라운드 타이머를 조이거나 OS 가 프로세스를 죽이면
 * 알림은 오지 않는다 — **그 보장은 이 파일의 계약이 아니다.**
 *
 * ## 잠금화면에 무엇을 쓰지 않는가
 *
 * 운동명·중량·반복·RIR·통증은 **넣지 않는다.** 잠금화면은 남이 보는 화면이고, 그 값들은
 * 건강 정보다. 그래서 문구는 어느 세트인지조차 말하지 않는 고정 문자열이다.
 *
 * ## 권한을 요청하지 않는다
 *
 * `Notification.requestPermission()` 을 부르지 않는다. 백그라운드에서 권한 프롬프트를 띄우는 것은
 * 사용자가 요청한 적 없는 방해이고, 제스처 없이 부르면 대부분의 브라우저가 거절한다.
 * **이미 `granted` 일 때만** 쓴다.
 */

/** 잠금화면에 그대로 뜨는 문구. 어느 운동인지 말하지 않는다. */
export const REST_NOTIFICATION = {
  title: "휴식이 끝났어요",
  body: "다음 세트를 시작할 시간이에요.",
  /** 같은 태그면 OS 가 알림을 대체한다 — 쌓이지 않게 한다. */
  tag: "afc-rest-complete",
} as const;

/**
 * 페이지가 **실제로** 숨겨져 있는가. 숨겨지지 않았다면 사용자가 화면을 보고 있으므로
 * 알림은 방해일 뿐이다.
 */
function isHidden(): boolean {
  return globalThis.document?.visibilityState === "hidden";
}

function permissionGranted(): boolean {
  // `Notification` 자체가 없는 환경(구형 iOS·SSR)에서는 조회만으로도 던질 수 있다.
  try {
    return globalThis.Notification?.permission === "granted";
  } catch {
    return false;
  }
}

/**
 * 휴식이 끝났음을 알린다.
 *
 * **모든 조건이 맞을 때만** 한 번 띄운다: 페이지가 숨겨져 있고, 권한이 이미 `granted` 이고,
 * 서비스워커 등록과 `showNotification` 이 실제로 있을 때. 하나라도 아니면 조용히 지나간다.
 *
 * 호출 횟수 제어(같은 타이머 중복 금지)는 호출부가 한다.
 *
 * @returns 실제로 띄웠는지. 테스트와 호출부의 중복 방지에 쓴다.
 */
export async function notifyRestComplete(): Promise<boolean> {
  if (!isHidden() || !permissionGranted()) return false;

  try {
    const container = globalThis.navigator?.serviceWorker;
    if (!container) return false;

    const registration = await container.getRegistration();
    if (typeof registration?.showNotification !== "function") return false;

    // **문구와 태그뿐이다.** 기본값과 같은 옵션(`renotify: false`·`silent: false`)은 적지 않는다 —
    // 적어 봐야 payload 표면만 넓어지고 동작은 같다.
    await registration.showNotification(REST_NOTIFICATION.title, {
      body: REST_NOTIFICATION.body,
      tag: REST_NOTIFICATION.tag,
    });
    return true;
  } catch {
    // 미지원·거부·SW 미등록 전부 여기로 온다. 알림이 없을 뿐 기록과 화면은 그대로 간다.
    return false;
  }
}

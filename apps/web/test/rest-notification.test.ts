/**
 * 휴식 종료 best-effort 알림 계약.
 *
 * 이 기능의 위험은 "안 뜨는 것"이 아니라 **뜨면 안 될 때 뜨는 것**이다 —
 * 화면을 보고 있는데 알림이 오거나, 잠금화면에 운동명·중량이 찍히거나,
 * 권한 프롬프트가 백그라운드에서 튀어나오거나, 알림 실패가 기록을 막는 것.
 * 그래서 단언의 대부분이 **0회** 를 확인한다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { REST_NOTIFICATION, notifyRestComplete } from "../lib/rest-notification";

type Showed = { title: string; options: NotificationOptions };

function setup({
  visibility = "hidden",
  permission = "granted",
  registration = "ok",
}: {
  visibility?: string | null;
  permission?: string | null;
  registration?: "ok" | "none" | "no-method" | "throws" | "missing-container";
} = {}) {
  const showed: Showed[] = [];
  const showNotification = vi.fn((title: string, options: NotificationOptions) => {
    showed.push({ title, options });
    return Promise.resolve();
  });

  if (visibility === null) Reflect.deleteProperty(globalThis, "document");
  else define("document", { visibilityState: visibility });

  if (permission === null) Reflect.deleteProperty(globalThis, "Notification");
  else define("Notification", { permission });

  const getRegistration = vi.fn(() => {
    if (registration === "throws") return Promise.reject(new Error("SecurityError"));
    if (registration === "none") return Promise.resolve(undefined);
    if (registration === "no-method") return Promise.resolve({});
    return Promise.resolve({ showNotification });
  });

  define(
    "navigator",
    registration === "missing-container" ? {} : { serviceWorker: { getRegistration } },
  );

  return { showed, showNotification, getRegistration };
}

function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

afterEach(() => {
  for (const name of ["document", "Notification", "navigator"])
    Reflect.deleteProperty(globalThis, name);
  vi.restoreAllMocks();
});

describe("띄우는 조건 — 전부 맞을 때만", () => {
  it("숨겨져 있고 권한이 granted 면 한 번 띄운다", async () => {
    const { showNotification } = setup();

    await expect(notifyRestComplete()).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it.each([["visible"], ["prerender"]])(
    "화면이 %s 면 띄우지 않는다 — 보고 있는 사람에게 알림은 방해다",
    async (state) => {
      const { showNotification } = setup({ visibility: state });

      await expect(notifyRestComplete()).resolves.toBe(false);

      expect(showNotification).not.toHaveBeenCalled();
    },
  );

  it.each([["denied"], ["default"]])("권한이 %s 면 띄우지 않는다", async (permission) => {
    const { showNotification, getRegistration } = setup({ permission });

    await expect(notifyRestComplete()).resolves.toBe(false);

    expect(showNotification).not.toHaveBeenCalled();
    // 권한이 없으면 서비스워커까지 가지도 않는다.
    expect(getRegistration).not.toHaveBeenCalled();
  });

  it("Notification API 자체가 없으면 띄우지 않는다(구형 iOS)", async () => {
    const { showNotification } = setup({ permission: null });

    await expect(notifyRestComplete()).resolves.toBe(false);

    expect(showNotification).not.toHaveBeenCalled();
  });

  it("document 가 없으면(SSR) 띄우지 않는다", async () => {
    const { showNotification } = setup({ visibility: null });

    await expect(notifyRestComplete()).resolves.toBe(false);

    expect(showNotification).not.toHaveBeenCalled();
  });
});

describe("권한을 요청하지 않는다", () => {
  it("requestPermission 을 부르지 않는다 — 백그라운드 프롬프트 금지", async () => {
    const requestPermission = vi.fn(() => Promise.resolve("granted"));
    setup({ permission: "default" });
    define("Notification", { permission: "default", requestPermission });

    await notifyRestComplete();

    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("granted 상태에서도 부르지 않는다", async () => {
    const requestPermission = vi.fn(() => Promise.resolve("granted"));
    setup();
    define("Notification", { permission: "granted", requestPermission });

    await notifyRestComplete();

    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe("서비스워커가 없거나 깨져도 조용히 지나간다", () => {
  it.each([
    ["등록이 없다", "none" as const],
    ["showNotification 이 없다", "no-method" as const],
    ["getRegistration 이 던진다", "throws" as const],
    ["serviceWorker 컨테이너가 없다", "missing-container" as const],
  ])("%s 면 false 이고 던지지 않는다", async (_label, registration) => {
    setup({ registration });

    await expect(notifyRestComplete()).resolves.toBe(false);
  });

  it("showNotification 이 거부해도 예외가 새지 않는다", async () => {
    const { showNotification } = setup();
    showNotification.mockReturnValue(Promise.reject(new Error("NotAllowedError")));

    await expect(notifyRestComplete()).resolves.toBe(false);
  });
});

describe("잠금화면 문구 — 민감정보 금지", () => {
  it("고정 문구만 나간다", async () => {
    const { showed } = setup();

    await notifyRestComplete();

    expect(showed[0].title).toBe("휴식이 끝났어요");
    expect(showed[0].options.body).toBe("다음 세트를 시작할 시간이에요.");
    expect(REST_NOTIFICATION.tag).toBe("afc-rest-complete");
  });

  it("payload 에 **숫자가 하나도 없다** — 중량·반복·RIR·세트번호가 한 번에 걸린다", async () => {
    const { showed } = setup();

    await notifyRestComplete();

    // 태그(`afc-rest-complete`)까지 포함해 전부 본다. 민감한 값은 전부 수치라서
    // 개별 단어를 나열하는 것보다 "숫자 없음"이 촘촘하다.
    expect(JSON.stringify(showed[0])).not.toMatch(/\d/);
  });

  it("운동명·통증 같은 식별 문구가 없다", async () => {
    const { showed } = setup();

    await notifyRestComplete();

    const payload = JSON.stringify(showed[0]);
    for (const leak of ["벤치", "프레스", "스쿼트", "kg", "RIR", "rir", "통증", "pain"])
      expect(payload).not.toContain(leak);
  });

  it("payload 는 문구와 태그뿐이다 — 임의 데이터를 싣지 않는다", async () => {
    const { showed } = setup();

    await notifyRestComplete();

    expect(Object.keys(showed[0].options).sort()).toEqual(["body", "tag"]);
  });

  it("같은 태그로 대체한다 — 알림이 쌓이지 않는다", async () => {
    const { showed } = setup();

    await notifyRestComplete();
    await notifyRestComplete();

    expect(showed.every((item) => item.options.tag === "afc-rest-complete")).toBe(true);
  });
});

/**
 * 휴식 종료 피드백의 **실제 배선**(T1 독립 리뷰 P2-1).
 *
 * 단위 테스트는 helper 를 직접 부르고, `renderToStaticMarkup` 은 `useEffect` 와 클릭을 실행하지 않는다.
 * 그래서 "정말 `SetRow → ExerciseCard → SessionScreen.handleComplete` 스택에서 unlock 이
 * 첫 비동기 저장보다 앞서는가", "`RestTimerSheet` 이펙트가 종료를 신호로 넘기는가"는 증거가 없었다.
 * 여기서 진짜 브라우저로 그 두 가지를 밟는다.
 *
 * **제품 코드에 테스트 전용 플래그를 넣지 않는다.** 계측은 전부 `addInitScript` 로 브라우저 쪽에서 한다 —
 * 제품은 `globalThis.AudioContext` 와 `navigator.vibrate` 를 호출 시점에 읽으므로 그대로 관측된다.
 * 순서 증거는 `IDBObjectStore.prototype.put` 을 감싸 얻는다(세트 완료의 첫 비동기 저장이 Dexie 쓰기다).
 *
 * 물리적인 소리 크기·진동 체감은 여기서 판정하지 않는다 — Galaxy `dev:lan` 후보 릴리스 검증 소관이다.
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { openSession, seedProgram, todaySession } from "./helpers";

type ProbeEvent = { seq: number; kind: string; store?: string; pattern?: number[] };

declare global {
  interface Window {
    __afcProbe: { events: ProbeEvent[] };
    __afcSetHidden: (hidden: boolean) => void;
  }
}

let sessionId: string;

test.beforeEach(async ({ request }) => {
  await seedProgram(request);
  sessionId = await todaySession(request);
});

/**
 * 브라우저 쪽 계측. 앱 스크립트보다 먼저 돈다.
 *
 * `visibilityState` 를 조작 가능하게 만드는 이유: Playwright 에는 탭을 숨기는 API 가 없는데,
 * "백그라운드에서 끝난 휴식은 복귀해도 울리지 않는다"가 계약이라 그 경계를 실제로 밟아야 한다.
 */
async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let seq = 0;
    const probe = { events: [] as ProbeEvent[] };
    const record = (kind: string, detail: Record<string, unknown> = {}) => {
      probe.events.push({ seq: (seq += 1), kind, ...detail } as ProbeEvent);
    };
    window.__afcProbe = probe;

    class ProbeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      constructor() {
        record("audiocontext");
      }
      createOscillator() {
        record("oscillator");
        return {
          frequency: { value: 0 },
          connect: () => {},
          start: () => record("beep-start"),
          stop: () => {},
        };
      }
      createGain() {
        return { gain: { value: 0 }, connect: () => {} };
      }
      resume() {
        record("resume");
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      value: ProbeAudioContext,
      configurable: true,
      writable: true,
    });

    Object.defineProperty(navigator, "vibrate", {
      value: (pattern: number[]) => {
        record("vibrate", { pattern });
        return true;
      },
      configurable: true,
      writable: true,
    });

    // 세트 완료의 첫 비동기 저장은 Dexie(IndexedDB) 쓰기다. unlock 이 그보다 앞서야 한다.
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: unknown[]) {
      record("idb-put", { store: this.name });
      return (put as (...a: unknown[]) => IDBRequest).apply(this, args);
    } as typeof put;

    let hidden = false;
    for (const [property, value] of [
      ["visibilityState", () => (hidden ? "hidden" : "visible")],
      ["hidden", () => hidden],
    ] as const) {
      Object.defineProperty(document, property, { get: value, configurable: true });
    }
    window.__afcSetHidden = (next: boolean) => {
      hidden = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
}

const events = (page: Page) => page.evaluate(() => window.__afcProbe.events);
const countOf = async (page: Page, kind: string) =>
  (await events(page)).filter((event) => event.kind === kind).length;

/**
 * 첫 세트를 채우고 완료 체크 → 휴식 타이머를 연다. 실제 UI 경로만 쓴다.
 *
 * 클릭 **직전에** 기록을 비운다. 세션 화면은 진입할 때도 미러·초안을 IndexedDB 에 쓰기 때문에,
 * 비우지 않으면 "첫 저장"이 클릭과 무관한 로드 시점 쓰기가 된다(실측: unlock 5 vs put 1).
 */
async function completeFirstSet(page: Page): Promise<string> {
  await openSession(page, sessionId);
  const check = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");
  await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("40");
  await page.getByLabel(`${name} 1세트 횟수, 회`).fill("10");
  await page.evaluate(() => {
    window.__afcProbe.events.length = 0;
  });
  await check.click();
  await expect(
    page.getByRole("dialog", { name: new RegExp(`${name} 1세트 후 휴식`) }),
  ).toBeVisible();
  return name;
}

test("세트 완료 클릭에서 AudioContext unlock 이 첫 비동기 저장보다 먼저다", async ({ page }) => {
  await installProbe(page);
  await completeFirstSet(page);

  const recorded = await events(page);
  const unlockAt = recorded.find((event) => event.kind === "audiocontext")?.seq;
  // 세트 완료의 저장은 초안과 아웃박스에 들어간다 — 그 두 스토어만 본다.
  const firstWriteAt = recorded.find(
    (event) => event.kind === "idb-put" && ["drafts", "outbox"].includes(event.store ?? ""),
  )?.seq;

  expect(unlockAt, "완료 클릭이 AudioContext 를 열어야 한다").toBeDefined();
  expect(firstWriteAt, "완료 클릭이 기록을 저장해야 한다").toBeDefined();
  // await 뒤로 밀리면 이 순서가 뒤집힌다 — 사용자 제스처 밖이라 iOS 에서 무음이 된다.
  expect(unlockAt!).toBeLessThan(firstWriteAt!);

  // 아직 휴식이 끝나지 않았으므로 소리도 진동도 없다.
  expect(await countOf(page, "beep-start")).toBe(0);
  expect(await countOf(page, "vibrate")).toBe(0);
});

test("타이머가 0에 닿으면 비프·진동이 각각 정확히 한 번이다", async ({ page }) => {
  await installProbe(page);
  await page.clock.install();
  const name = await completeFirstSet(page);
  await page.clock.fastForward("02:05");

  await expect(page.getByRole("timer")).toHaveText("0:00");
  await expect(page.getByText("휴식 완료").first()).toBeVisible();
  expect(await countOf(page, "beep-start")).toBe(1);
  expect(await countOf(page, "vibrate")).toBe(1);

  const vibrated = (await events(page)).find((event) => event.kind === "vibrate");
  expect(vibrated?.pattern).toEqual([120]);

  // 틱·focus·pageshow·visibilitychange 를 더 밟아도 늘지 않는다.
  await page.clock.runFor(3000);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1000);
  expect(await countOf(page, "beep-start")).toBe(1);
  expect(await countOf(page, "vibrate")).toBe(1);

  // 화면 계약은 그대로다 — 0에서 멈추고 자동으로 닫지 않는다.
  await expect(page.getByRole("timer")).toHaveText("0:00");
  await expect(
    page.getByRole("dialog", { name: new RegExp(`${name} 1세트 후 휴식`) }),
  ).toBeVisible();
});

test("휴식을 더하면 그 타이머가 끝날 때 다시 한 번 울린다", async ({ page }) => {
  await installProbe(page);
  await page.clock.install();
  await completeFirstSet(page);
  await page.clock.fastForward("02:05");
  expect(await countOf(page, "beep-start")).toBe(1);

  // 종료 상태에서는 +버튼이 숨으므로 휴식 종료 후 2세트를 완료해 새 타이머를 연다.
  await page.getByRole("button", { name: "다음 세트" }).click();
  const check = page.getByRole("button", { name: /2세트 완료 처리$/ }).first();
  const name = ((await check.getAttribute("aria-label")) ?? "").replace(/ 2세트 완료 처리$/, "");
  await page.getByLabel(`${name} 2세트 무게, 킬로그램`).fill("40");
  await page.getByLabel(`${name} 2세트 횟수, 회`).fill("8");
  await check.click();
  await expect(
    page.getByRole("dialog", { name: new RegExp(`${name} 2세트 후 휴식`) }),
  ).toBeVisible();

  await page.clock.fastForward("02:05");
  await expect(page.getByRole("timer")).toHaveText("0:00");
  expect(await countOf(page, "beep-start")).toBe(2);
  expect(await countOf(page, "vibrate")).toBe(2);
});

test("백그라운드에서 끝난 휴식은 복귀해도 울리지 않는다", async ({ page }) => {
  await installProbe(page);
  await page.clock.install();
  await completeFirstSet(page);

  // 탭을 숨긴 상태로 휴식이 끝난다.
  await page.evaluate(() => window.__afcSetHidden(true));
  await page.clock.fastForward("02:05");

  // 복귀. 화면은 finished 로 바뀌지만(AC-T-7) 소리·진동은 나지 않는다(§4.7 알림 조건).
  await page.evaluate(() => window.__afcSetHidden(false));
  await page.clock.runFor(1000);

  await expect(page.getByRole("timer")).toHaveText("0:00");
  await expect(page.getByText("휴식 완료").first()).toBeVisible();
  expect(await countOf(page, "beep-start")).toBe(0);
  expect(await countOf(page, "vibrate")).toBe(0);
});

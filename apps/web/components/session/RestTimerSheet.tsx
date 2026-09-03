/**
 * 휴식 타이머 팝업(F2 카운트다운+진행 바 / F3 시간 가산 / F4 휴식 종료).
 * 계산은 전부 lib/rest-timer.ts(순수)에 있고, 여기서는 틱·포커스·낭독만 다룬다.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Button, ProgressBar, Sheet } from "../ui";
import {
  addRest,
  formatCountdown,
  formatDurationKo,
  isAtCap,
  milestoneMessage,
  remainingPercent,
  remainingSec,
  type RestTimer,
} from "../../lib/rest-timer";
import { useModal } from "./useModal";

const SHEET_ID = "rest-timer";
const END_BUTTON_ID = "rest-timer-end";
const CAP_NOTICE = "휴식은 최대 10분까지 늘릴 수 있어요.";
const ADD_STEPS = [
  { delta: 5, label: "+5초", aria: "휴식 5초 추가" },
  { delta: 10, label: "+10초", aria: "휴식 10초 추가" },
  { delta: 30, label: "+30초", aria: "휴식 30초 추가" },
  { delta: 60, label: "+1분", aria: "휴식 1분 추가" },
];

export type RestTimerSheetProps = {
  open: boolean;
  /** "벤치프레스 2세트 후 휴식" */
  title: string;
  timer: RestTimer;
  onChange: (timer: RestTimer) => void;
  onClose: () => void;
  /**
   * 종료 관측 보고. 세트·세션 정체성과 장부는 **호출부**가 갖는다.
   * 안정된 참조여야 한다 — 매 렌더 새 함수를 주면 이펙트가 매번 다시 돈다.
   */
  onCompletionObserved: (observation: {
    finished: boolean;
    endsAt: number;
    visibleSince: number | null;
  }) => void;
};

export function RestTimerSheet({
  open,
  title,
  timer,
  onChange,
  onClose,
  onCompletionObserved,
}: RestTimerSheetProps) {
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState("");
  const announcedRef = useRef<Set<number>>(new Set());
  const addAnnounceRef = useRef<number | undefined>(undefined);
  const visibleSinceRef = useRef<number | null>(null);

  useModal(open, SHEET_ID, onClose, END_BUTTON_ID);

  // 남은 시간은 매 틱 endsAt 에서 다시 계산한다(감산 누적 금지).
  // 탭 전환·bfcache 복귀 시에도 같은 계산을 즉시 한 번 더 돌린다.
  useEffect(() => {
    if (!open) return;

    // 전경이 된 시각을 같이 따라간다. 숨는 순간 잊고, 다시 보일 때 새로 찍는다 —
    // 그래야 "백그라운드에서 끝난 휴식"과 "보는 중에 끝난 휴식"이 구분된다(§4.7 알림 조건).
    const tick = () => {
      visibleSinceRef.current =
        document.visibilityState === "visible" ? (visibleSinceRef.current ?? Date.now()) : null;
      setNow(Date.now());
    };
    tick();
    const interval = window.setInterval(tick, 200);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      announcedRef.current = new Set();
      setAnnouncement("");
    }
  }, [open]);

  useEffect(() => () => window.clearTimeout(addAnnounceRef.current), []);

  const remaining = remainingSec(timer, now);
  const finished = remaining <= 0;
  const atCap = isAtCap(timer, now);

  // 마일스톤(60·30·10·0초)에서만 낭독한다 — 매초 낭독 금지(AC-A-3).
  useEffect(() => {
    if (!open) return;
    const milestone = milestoneMessage(remaining);
    if (!milestone || announcedRef.current.has(remaining)) return;
    announcedRef.current.add(remaining);
    setAnnouncement(milestone);
  }, [open, remaining]);

  /**
   * 종료를 **관측해서 보고만** 한다. 어느 신호를 낼지도, 몇 번 낼지도 게이트가 정한다.
   *
   * 게이트를 여기 두지 않는 이유가 분명하다 — 이 시트는 휴식마다 마운트/언마운트되므로
   * 안에 장부를 두면 **장부가 휴식보다 먼저 죽는다.** 세션 화면이 들고 있어야 열고 닫는 것을
   * 가로질러 "정확히 한 번"이 성립한다.
   *
   * 화면은 건드리지 않는다 — 타이머는 0에서 멈추고 시트는 열린 채로 남는다(§4.7).
   */
  useEffect(() => {
    if (!open) return;
    onCompletionObserved({ finished, endsAt: timer.endsAt, visibleSince: visibleSinceRef.current });
  }, [open, finished, timer.endsAt, onCompletionObserved]);

  const handleAdd = (delta: number) => {
    if (atCap) {
      setAnnouncement(CAP_NOTICE);
      return;
    }
    const result = addRest(timer, delta, Date.now());
    onChange(result.timer);
    announcedRef.current = new Set();

    // 연타 중에는 마지막 값만 읽어 준다(§7.4 500ms 디바운스).
    window.clearTimeout(addAnnounceRef.current);
    const nextRemaining = remainingSec(result.timer, Date.now());
    addAnnounceRef.current = window.setTimeout(() => {
      setAnnouncement(result.capped ? CAP_NOTICE : `남은 시간 ${formatDurationKo(nextRemaining)}`);
    }, 500);
  };

  return (
    <Sheet
      open={open}
      id={SHEET_ID}
      title={title}
      onScrimClick={onClose}
      footer={
        <Button id={END_BUTTON_ID} size="lg" fullWidth onClick={onClose}>
          {finished ? "다음 세트" : "휴식 종료"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p
          role="timer"
          aria-atomic="true"
          aria-live="off"
          // 매초 바뀌는 큰 수치다 → 모노 + tabular-nums(§4). 비례폭이면 "1:09" → "1:10" 에서
          // 글자가 좌우로 흔들린다.
          className="text-timer text-center font-mono font-bold tabular-nums text-fg"
        >
          {formatCountdown(remaining)}
        </p>

        <p className="text-center text-base font-medium text-fg-muted">
          {finished ? "휴식 완료" : "남은 휴식 시간"}
        </p>

        {/* 진행 바는 카운트다운과 같은 정보라 보조기기에서는 숨긴다(§4.4). */}
        <div aria-hidden="true">
          <ProgressBar value={remainingPercent(timer, now)} label="휴식 남은 시간" />
        </div>

        {finished ? null : (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              {ADD_STEPS.map((step) => (
                <Button
                  key={step.delta}
                  variant="secondary"
                  size="md"
                  // nowrap 으로 "+30초" 가 두 줄로 접히는 것을 막고, min-w-0 으로 한 줄 4등분을 유지한다(§8).
                  className="min-w-0 flex-1 whitespace-nowrap px-0"
                  aria-label={step.aria}
                  aria-disabled={atCap || undefined}
                  onClick={() => handleAdd(step.delta)}
                >
                  {step.label}
                </Button>
              ))}
            </div>
            {atCap ? <p className="text-center text-sm text-fg-muted">{CAP_NOTICE}</p> : null}
          </div>
        )}
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </Sheet>
  );
}

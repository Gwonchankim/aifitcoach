"use client";

/**
 * 온보딩 7스텝 (F0 / UX_STATES §2.1).
 *
 * - 스텝 이동은 URL 해시(`#step-3`)에 기록한다 → **브라우저 뒤로가기 = 이전 스텝**(AC-S1-1).
 * - 입력값은 매 변경마다 localStorage 에 저장한다 → 새로고침·중도 이탈에도 유지된다.
 *   (예외: 통증 부위는 민감정보라 저장하지 않는다 — draft.ts 참고)
 * - 제출은 `isPending` 으로 잠근다 → generate 가 두 번 호출되지 않는다(AC-S1-2).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card } from "../ui";
import {
  DaysStep,
  EquipmentStep,
  ExperienceStep,
  GoalStep,
  MinutesStep,
  PainStep,
  ProfileStep,
  type StepProps,
} from "./steps";
import {
  INITIAL_DRAFT,
  type OnboardingDraft,
  STEP_COUNT,
  STEP_TITLES,
  clampStep,
  clearDraft,
  loadDraft,
  saveDraft,
  toGenerateRequest,
} from "./draft";
import { api } from "../../lib/api";
import { GENERATE_PROGRAM_ERRORS, toUiError } from "../../lib/error-copy";

/** 순서는 STEP_TITLES 와 1:1 이어야 한다(FEATURES_UX F0 수집 순서). */
const STEPS: ((props: StepProps) => React.ReactElement)[] = [
  ProfileStep,
  GoalStep,
  DaysStep,
  MinutesStep,
  ExperienceStep,
  EquipmentStep,
  PainStep,
];

function readStepFromHash(): number {
  const match = /^#step-(\d+)$/.exec(window.location.hash);
  return match ? clampStep(Number(match[1]) - 1) : 0;
}

export function OnboardingWizard() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<OnboardingDraft>(INITIAL_DRAFT);
  const [step, setStep] = useState(0);
  /** hydrated 전에는 저장값을 덮어쓰지 않는다(첫 렌더의 기본값이 저장되는 사고 방지). */
  const [hydrated, setHydrated] = useState(false);
  const [resumeFrom, setResumeFrom] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** 이 화면에서 직접 쌓은 히스토리 항목 수. 0이면 뒤로가기가 온보딩 밖으로 나간다. */
  const pushedRef = useRef(0);

  // 저장된 초안 복원 + 해시 동기화.
  useEffect(() => {
    const stored = loadDraft();
    if (stored) {
      setDraft(stored.draft);
      if (stored.step > 0) setResumeFrom(stored.step);
    }
    setStep(readStepFromHash());
    setHydrated(true);

    const onPopState = () => {
      pushedRef.current = Math.max(0, pushedRef.current - 1);
      setStep(readStepFromHash());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (hydrated) saveDraft({ draft, step });
  }, [hydrated, draft, step]);

  const goToStep = useCallback((next: number, mode: "push" | "replace") => {
    const clamped = clampStep(next);
    const hash = `#step-${clamped + 1}`;
    if (mode === "push") {
      window.history.pushState(null, "", hash);
      pushedRef.current += 1;
    } else {
      window.history.replaceState(null, "", hash);
    }
    setStep(clamped);
  }, []);

  /** [이전]은 브라우저 뒤로가기와 같게 동작한다. 쌓인 항목이 없으면(이어하기 직후) 스텝만 되돌린다. */
  const goBack = useCallback(() => {
    if (pushedRef.current > 0) window.history.back();
    else goToStep(step - 1, "replace");
  }, [goToStep, step]);

  // 스텝이 바뀌면 제목으로 포커스를 옮긴다(스크린리더가 새 스텝을 읽는다).
  useEffect(() => {
    if (hydrated) headingRef.current?.focus();
  }, [hydrated, step]);

  const mutation = useMutation({
    mutationFn: () => api.generateProgram(toGenerateRequest(draft)),
    onSuccess: (program) => {
      queryClient.setQueryData(["program", "current"], program);
      clearDraft();
      router.replace("/program");
    },
    onError: (error) => setSubmitError(toUiError(error, GENERATE_PROGRAM_ERRORS).message),
  });

  const submit = () => {
    if (mutation.isPending) return;
    setSubmitError(null);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setSubmitError("인터넷이 연결되면 계획을 만들어 드릴게요. 입력한 내용은 저장해 뒀어요.");
      return;
    }
    mutation.mutate();
  };

  const patch = (values: Partial<OnboardingDraft>) => setDraft((prev) => ({ ...prev, ...values }));

  if (resumeFrom !== null) {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 p-4">
        <h1 className="text-2xl font-bold text-fg">이어서 진행할게요.</h1>
        <p className="text-fg-muted">지난번에 입력하신 내용을 그대로 두었어요.</p>
        {/* 통증 부위는 저장하지 않으므로(민감정보) 마지막 스텝으로 돌아오면 다시 골라야 한다. */}
        {resumeFrom === STEP_COUNT - 1 ? (
          <p className="text-fg-muted">통증 부위는 저장하지 않아서 다시 골라 주세요.</p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            fullWidth
            onClick={() => {
              const target = resumeFrom;
              setResumeFrom(null);
              goToStep(target, "replace");
            }}
          >
            이어하기
          </Button>
          <Button
            variant="secondary"
            size="md"
            fullWidth
            onClick={() => {
              setDraft(INITIAL_DRAFT);
              setResumeFrom(null);
              goToStep(0, "replace");
            }}
          >
            처음부터
          </Button>
        </div>
      </div>
    );
  }

  const StepComponent = STEPS[step];
  const isLast = step === STEP_COUNT - 1;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col p-4 pb-safe-bottom">
      <p className="text-sm font-medium text-fg-muted" aria-hidden="true">
        {step + 1}/{STEP_COUNT}
      </p>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-1 text-2xl font-bold text-fg focus-visible:outline-none"
      >
        <span className="sr-only">
          {STEP_COUNT}단계 중 {step + 1}단계.{" "}
        </span>
        {STEP_TITLES[step]}
      </h1>

      <div className="mt-6 flex-1">
        <StepComponent draft={draft} onChange={patch} />
      </div>

      {submitError ? (
        <Card role="alert" tone="raised" className="mt-4 border-danger">
          <p className="text-sm text-fg">{submitError}</p>
        </Card>
      ) : null}

      <div className="sticky bottom-0 mt-6 flex gap-2 bg-bg pt-3 pb-safe-bottom">
        {/* [다음]이 전폭이라 shrink-0 이 없으면 [이전]이 "이/전" 으로 줄바꿈된다(390px). */}
        {step > 0 ? (
          <Button variant="secondary" size="lg" className="shrink-0" onClick={goBack}>
            이전
          </Button>
        ) : null}
        {isLast ? (
          <Button size="lg" fullWidth onClick={submit} disabled={mutation.isPending}>
            계획 만들기
          </Button>
        ) : (
          <Button size="lg" fullWidth onClick={() => goToStep(step + 1, "push")}>
            다음
          </Button>
        )}
      </div>

      {mutation.isPending ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-bg px-6 text-center"
        >
          <p className="text-xl font-bold text-fg">운동 계획을 만들고 있어요.</p>
          <p className="text-fg-muted">잠시만요.</p>
        </div>
      ) : null}
    </div>
  );
}

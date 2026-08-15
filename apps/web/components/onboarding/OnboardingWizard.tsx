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
import { Button, Card, Kicker } from "../ui";
// index.ts 에 아직 없어 직접 경로로 가져온다(design 에 export 추가를 요청해 뒀다).
import { ActionBar } from "../ui/ActionBar";
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
        {/* 설명 문단은 `ink-2`(DESIGN_TOKENS §2.1) — `muted` 는 캡션·라벨 자리다. */}
        <p className="text-sm text-ink-2">지난번에 입력하신 내용을 그대로 두었어요.</p>
        {/* 통증 부위는 저장하지 않으므로(민감정보) 마지막 스텝으로 돌아오면 다시 골라야 한다. */}
        {resumeFrom === STEP_COUNT - 1 ? (
          <p className="text-sm text-ink-2">통증 부위는 저장하지 않아서 다시 골라 주세요.</p>
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

  /*
    F0-0 "짧으면 따라 올라오고, 길면 고정".
    컨테이너는 **콘텐츠 높이만큼만** 자란다 — `min-h-dvh flex-col` + 콘텐츠 `flex-1` 로 두면
    짧은 스텝(주당일수·시간)에서도 버튼이 화면 맨 아래로 밀려 가운데가 통째로 빈다.
    대신 콘텐츠 영역에 최소 높이를 줘서, 짧은 스텝에서도 버튼 블록이 엄지 범위(하단 1/3)에
    들어오게 한다(AC-S1-6). 길어지면 ActionBar 의 sticky 가 알아서 하단에 고정한다.
    조상에 overflow-hidden/auto 를 두면 sticky 가 죽는다 — 넣지 마라.
  */
  return (
    <div className="mx-auto w-full max-w-md p-4">
      {/* 화면 상단의 진행 표시 = 숫자만 있는 섹션 키커다(DESIGN_TOKENS §4, 10.5px·.18em).
          한글이 아니라 모노 글리프가 다 있고, `.font-mono` 가 tabular-nums 를 함께 켠다.
          스크린리더에는 h1 의 sr-only 문구("N단계 중 M단계")가 이미 있어 여기는 계속 숨긴다. */}
      <Kicker as="p" className="text-kicker-lg" aria-hidden="true">
        {step + 1}/{STEP_COUNT}
      </Kicker>
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

      <div className="mt-6 min-h-[52dvh]">
        <StepComponent draft={draft} onChange={patch} />
      </div>

      {/* 상태 면은 Phase B 배지와 같은 소프트 어법이다 — 면 `danger-bg` + 1px `danger` 테두리.
          `cn` 이 Card 기본 `bg-surface` 와 충돌을 해소해 호출부의 `bg-danger-bg` 를 남긴다.
          본문 글자는 문장이라 `fg` 를 유지한다(danger-bg 위 15.87:1). */}
      {submitError ? (
        <Card role="alert" className="mt-4 border-danger bg-danger-bg">
          <p className="text-sm text-fg">{submitError}</p>
        </Card>
      ) : null}

      <ActionBar className="mt-6">
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
      </ActionBar>

      {mutation.isPending ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-bg px-6 text-center"
        >
          <p className="text-xl font-bold text-fg">운동 계획을 만들고 있어요.</p>
          <p className="text-sm text-ink-2">잠시만요.</p>
        </div>
      ) : null}
    </div>
  );
}

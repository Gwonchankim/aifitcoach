/**
 * 대시보드 뷰모델 (F8 / UX_STATES §2.3) — 순수 함수.
 * `DashboardSummary` 하나에서 오늘/내일/지표 카드 문구와 액션을 만든다. 렌더는 DashboardScreen 이 한다.
 */
import type { DashboardSummary } from "../../lib/api";
import { focusLabel, formatKg, formatRate } from "../../lib/program-labels";

export type DashboardAction = { label: string; href: string };

export type TodayCard = {
  status: "workout" | "in_progress" | "rest" | "done" | "partial" | "conflict" | "return_after_gap";
  heading: string;
  message: string;
  /** PR·볼륨 보조 문구. 해당 없으면 넣지 않는다(0개 표시 금지). */
  notes: string[];
  primary: DashboardAction | null;
  secondary: DashboardAction | null;
};

export type MetricCard = {
  label: string;
  /** null 이면 수치 대신 note 만 보여준다(빈 상태). */
  value: string | null;
  note: string | null;
};

export type DashboardView = {
  today: TodayCard;
  tomorrow: { heading: string; message: string };
  streak: MetricCard;
  weekly: MetricCard;
};

function routineSentence(
  prefix: string,
  summary: { exercise_count: number; focus: string } | null | undefined,
): string {
  if (!summary) return `${prefix}은 운동하는 날이에요.`;
  const focus = focusLabel(summary.focus);
  const focusPart = focus ? `${focus} ` : "";
  return `${prefix}은 ${focusPart}운동 ${summary.exercise_count}개예요.`;
}

type DoneSummary = { total_volume: number; sets_completed: number; pr_count: number };

/**
 * `total_volume` 은 맨몸·시간 종목을 빼고 센 값인데 `sets_completed` 에는 그 세트가 들어간다.
 * 그래서 맨몸만 한 날은 볼륨이 0으로 온다 — `0kg` 을 그대로 쓰지 않고 세트 수로 말한다.
 *
 * @param localSetsCompleted 이 기기에 남아 있는 완료 세트 수. 서버 요약이 0인데 이 값이 있으면
 * "기록이 없다"고 **단정하지 않는다** — 요약 화면은 같은 순간에 세트 수를 보여주고 있다.
 */
function doneCopy(
  done: DoneSummary,
  localSetsCompleted: number,
): { message: string; notes: string[] } {
  const notes: string[] = [];

  if (done.sets_completed === 0) {
    return {
      message:
        localSetsCompleted > 0
          ? `오늘 ${localSetsCompleted}세트를 기록했어요. 이 기기에만 있는 기록이라 연결되면 요약에 반영돼요.`
          : "오늘 운동을 마쳤어요. 기록한 세트는 없어요.",
      notes,
    };
  }

  const message =
    done.total_volume > 0
      ? `오늘 운동 완료! 총 ${formatKg(done.total_volume)} · ${done.sets_completed}세트`
      : `오늘 운동 완료! ${done.sets_completed}세트를 마쳤어요.`;

  if (done.total_volume === 0) {
    notes.push("맨몸으로 하는 운동은 무게 합계에 넣지 않아요.");
  }
  if (done.pr_count > 0) {
    notes.push(`개인 기록 ${done.pr_count}개를 새로 세웠어요.`);
  }

  return { message, notes };
}

function todayCard(today: DashboardSummary["today"], localSetsCompleted: number): TodayCard {
  const sessionHref = today.session_id ? `/session/${today.session_id}` : null;

  if (today.status === "rest") {
    return {
      status: "rest",
      heading: "오늘은 휴식",
      message: "오늘은 휴식이에요. 잘 쉬는 것도 훈련이에요.",
      notes: [],
      primary: null,
      secondary: { label: "내일 루틴 보기", href: "/program" },
    };
  }

  // 분기는 status 로만 한다. routine_summary 는 done 일 때도 non-null 로 내려온다.
  if (today.status === "done" || today.status === "partial") {
    const done = today.done_summary;
    const copy = done
      ? doneCopy(done, localSetsCompleted)
      : { message: "오늘 운동을 마쳤어요.", notes: [] };
    return {
      status: today.status,
      heading: "오늘 수행한 운동",
      message: copy.message,
      notes: copy.notes,
      // AC-S3-1: done 이면 [운동 시작] 이 보이지 않는다.
      primary: sessionHref ? { label: "기록 보기", href: sessionHref } : null,
      secondary: null,
    };
  }

  if (today.status === "in_progress") {
    return {
      status: "in_progress",
      heading: "진행 중인 세션",
      message:
        localSetsCompleted > 0
          ? `${localSetsCompleted}세트 기록됨 · 기기에 저장됨`
          : "진행 중인 세션을 이어서 기록하세요.",
      notes: [],
      primary: sessionHref ? { label: "이어하기", href: sessionHref } : null,
      secondary: null,
    };
  }

  if (today.status === "conflict") {
    return {
      status: "conflict",
      heading: "계획과 기록이 달라요",
      message: "예정된 루틴과 오늘 세션이 달라요. 현재 세션을 기준으로 확인해 주세요.",
      notes: ["일정 재배치나 건너뛰기는 여기서 자동 반영하지 않아요."],
      primary: sessionHref ? { label: "현재 세션 보기", href: sessionHref } : null,
      secondary: null,
    };
  }

  if (today.status === "return_after_gap") {
    return {
      status: "return_after_gap",
      heading: "추천 신뢰도 낮음",
      message: "마지막 완료 뒤 공백이 있어요. 기록이 다시 쌓이면 추천 신뢰도가 회복돼요.",
      notes: [],
      primary: sessionHref ? { label: "운동 시작", href: sessionHref } : null,
      secondary: null,
    };
  }

  return {
    status: "workout",
    heading: "오늘 수행할 운동",
    message: routineSentence("오늘", today.routine_summary),
    notes: [],
    primary: sessionHref ? { label: "운동 시작", href: sessionHref } : null,
    secondary: null,
  };
}

export function buildDashboardView(
  summary: DashboardSummary,
  localSetsCompleted = 0,
): DashboardView {
  return {
    today: todayCard(summary.today, localSetsCompleted),
    tomorrow: {
      heading: "내일",
      message:
        summary.tomorrow.status === "rest"
          ? "내일은 휴식이에요."
          : routineSentence("내일", summary.tomorrow.routine_summary),
    },
    // streak_days = 연속으로 완료한 "운동일" 수다. 계획이 없는 날은 끊지 않고 건너뛰고,
    // 오늘을 아직 안 했다는 이유로 끊기지도 않는다 → "연속 운동일" 로 부르고 그 규칙을 함께 적는다.
    streak: {
      label: "연속 운동일",
      value: `${summary.streak_days}일`,
      note: summary.streak_days === 0 ? "오늘부터 시작해요" : "휴식일은 끊기지 않아요",
    },
    weekly:
      summary.weekly_completion_rate === 0
        ? { label: "이번 주 완료율", value: null, note: "이번 주 기록이 아직 없어요." }
        : {
            label: "이번 주 완료율",
            value: formatRate(summary.weekly_completion_rate),
            note: null,
          },
  };
}

/** e1RM 추세는 서버의 종목별 완료 세션 gate를 따른다. 값은 세 번째 세션부터 보인다(D-39). */
export const E1RM_EMPTY_NOTE = "같은 종목 기록이 세 세션 이상 쌓이면 변화를 보여드릴게요.";

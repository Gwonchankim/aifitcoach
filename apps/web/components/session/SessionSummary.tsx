/**
 * 운동 요약(F6 / UX_STATES S5): 볼륨 · 완료 세트 · 다음 추천 미리보기.
 * 다음 추천의 근거는 서버 `explanation` 을 그대로 보여준다(AC-S5-3).
 */
"use client";

import Link from "next/link";
import type { Exercise, GatedRecommendation, Recommendation } from "../../lib/api";
import { Badge, Button, Card, Stat, buttonBase, cn } from "../ui";
import { formatKg } from "./set-rules";

export type SessionSummaryProps = {
  completedCount: number;
  totalVolume: number;
  nextRecommendations: GatedRecommendation[];
  catalogById: Map<string, Exercise>;
  /** F6-1: 당일이면 루틴 화면으로 돌아가 기록을 더하거나 고칠 수 있다. 다른 날이면 넘기지 않는다. */
  onResume?: () => void;
};

export function SessionSummary({
  completedCount,
  totalVolume,
  nextRecommendations,
  catalogById,
  onResume,
}: SessionSummaryProps) {
  const visibleRecommendations = nextRecommendations.flatMap((item) =>
    item.recommendation === null ? [] : [{ ...item.recommendation, exercise_id: item.exercise_id }],
  );
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2">
        <h1 className="text-xl font-bold text-fg">
          {completedCount === 0 ? "오늘은 기록이 없어요" : "수고했어요"}
        </h1>
        {completedCount === 0 ? (
          <p className="text-base text-fg-muted">다음 운동에서 만나요.</p>
        ) : (
          <p className="text-base text-fg-muted">
            오늘 {completedCount}세트, {formatKg(totalVolume)} 들었어요.
          </p>
        )}
      </Card>

      {/* 완료 세트가 0개면 수치 카드를 만들지 않는다(§2.5 빈①: 0 을 크게 보여주지 않는다). */}
      {completedCount === 0 ? null : (
        <div className="grid grid-cols-2 gap-3">
          <Card>
            <Stat label="총 볼륨" value={formatKg(totalVolume)} />
          </Card>
          <Card>
            <Stat label="완료 세트" value={`${completedCount}세트`} />
          </Card>
        </div>
      )}

      {visibleRecommendations.length === 0 ? (
        <p className="text-sm text-fg-muted">다음 추천은 기록이 조금 더 쌓이면 보여드릴게요.</p>
      ) : (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-bold text-fg">다음 추천</h2>
          <ul className="flex flex-col gap-2">
            {visibleRecommendations.map((recommendation) => (
              <li key={recommendation.exercise_id}>
                <Card className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-fg">
                      {catalogById.get(recommendation.exercise_id)?.name_ko ?? "다음 운동"}
                    </h3>
                    <Badge>{recommendationTarget(recommendation)}</Badge>
                  </div>
                  <p className="text-sm text-fg-muted">{recommendation.explanation}</p>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      {onResume ? (
        <Button variant="secondary" size="md" fullWidth onClick={onResume}>
          기록 더하거나 고치기
        </Button>
      ) : null}

      <Link href="/" className={cn(buttonBase, "min-h-tap-lg bg-action px-6 text-action-fg")}>
        대시보드로
      </Link>
    </div>
  );
}

/** 무게 null(자체중량)·시간 종목은 해당 축만 보여준다. */
function recommendationTarget(recommendation: Recommendation): string {
  const parts: string[] = [];
  if (recommendation.weight != null) parts.push(formatKg(recommendation.weight));

  const { reps_low: repsLow, reps_high: repsHigh } = recommendation;
  if (repsLow != null && repsHigh != null && repsLow !== repsHigh)
    parts.push(`${repsLow}~${repsHigh}회`);
  else if (repsLow != null) parts.push(`${repsLow}회`);

  const { time_low_sec: timeLow, time_high_sec: timeHigh } = recommendation;
  if (timeLow != null && timeHigh != null && timeLow !== timeHigh)
    parts.push(`${timeLow}~${timeHigh}초`);
  else if (timeLow != null) parts.push(`${timeLow}초`);

  parts.push(`${recommendation.sets}세트`);
  return parts.join(" · ");
}

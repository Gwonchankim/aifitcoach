import { parseCardioSnapshot } from "shared";
import { Card } from "../ui";

export function CardioPrescriptionCard({
  prescription,
  name,
}: {
  prescription: unknown;
  name: string;
}) {
  const snapshot = parseCardioSnapshot(prescription);
  const state =
    prescription && typeof prescription === "object" && "recommendation_state" in prescription
      ? prescription.recommendation_state
      : undefined;
  const available = snapshot && (state === undefined || state === "ready");
  return (
    <Card data-testid="cardio-prescription" className="flex flex-col gap-2">
      <h3 className="text-base font-semibold text-fg">{name} · 유산소 처방</h3>
      {!available ? (
        <p role="status" className="text-sm text-fg-muted">
          유산소 처방을 확인할 수 없어요. 다시 불러와 주세요.
        </p>
      ) : (
        <>
          <p className="text-sm text-fg">
            {snapshot.long_session_flag ? "긴 유산소 · " : ""}
            {snapshot.duration_sec / 60}분 · RPE {snapshot.target_rpe_low}–
            {snapshot.target_rpe_high}
          </p>
          <p className="text-sm text-fg-muted">
            {snapshot.prescription_kind === "interval_cardio"
              ? "몇 단어 뒤 호흡이 필요한 강도"
              : "대화는 가능하고 노래는 어려운 강도"}
          </p>
          {snapshot.prescription_kind === "interval_cardio" ? (
            <p className="text-sm text-fg">
              {snapshot.rounds}라운드 · 운동 {snapshot.work_sec}초 · 회복 {snapshot.recovery_sec}초
              (RPE {snapshot.recovery_rpe_low}–{snapshot.recovery_rpe_high}) · 마지막 회복 포함
            </p>
          ) : null}
          <p className="text-xs text-fg-muted">
            중강도 {snapshot.intensity_seconds.moderate}초 · 고강도{" "}
            {snapshot.intensity_seconds.high}초 · 회복 {snapshot.intensity_seconds.recovery}초
          </p>
        </>
      )}
      <p className="text-xs text-fg-muted">읽기 전용 · 유산소 수행 기록은 아직 지원하지 않아요.</p>
    </Card>
  );
}

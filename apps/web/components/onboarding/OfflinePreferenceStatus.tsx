import { formatClock } from "../../lib/use-online";

/** Preference-specific feedback; existing screen-level offline banners stay untouched. */
export function OfflinePreferenceStatus({
  online,
  stale,
  cachedAt,
}: {
  online: boolean;
  stale: boolean;
  cachedAt?: number;
}) {
  if (online && !stale) return null;
  const reason = online
    ? "연결을 확인한 뒤 선호를 바꿔 주세요."
    : "오프라인이라 지금은 선호를 바꿀 수 없어요. 연결되면 바꿀 수 있어요.";
  return (
    <div className="flex flex-col gap-1 text-sm text-ink-2">
      {cachedAt !== undefined ? (
        <p role="status" className="text-xs text-fg-muted">
          오프라인 · 마지막 동기화 <span className="font-mono">{formatClock(cachedAt)}</span> 기준
        </p>
      ) : null}
      <p role={cachedAt === undefined ? "status" : undefined}>{reason}</p>
    </div>
  );
}

/** Preference-specific feedback; existing screen-level offline banners stay untouched. */
export function OfflinePreferenceStatus({ online, stale }: { online: boolean; stale: boolean }) {
  if (online && !stale) return null;
  return (
    <p role="status" className="text-sm text-ink-2">
      오프라인이라 지금은 선호를 바꿀 수 없어요. 연결되면 바꿀 수 있어요.
    </p>
  );
}

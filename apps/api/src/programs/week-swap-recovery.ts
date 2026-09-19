export type WeekSwapRecoverySession = {
  readonly key: string;
  readonly date: string;
  readonly regions: readonly ("upper" | "lower" | "core")[];
};

export type WeekSwapRecoveryViolation = {
  keys: readonly [string, string];
  gapDays: number;
  overlap: ("upper" | "lower")[];
};

export type WeekSwapRecoveryResult = {
  ok: boolean;
  reason: null | "recovery_unverifiable" | "recovery_gap_violation";
  violations: WeekSwapRecoveryViolation[];
};

export function checkWeekSwapRecovery(
  sessions: readonly WeekSwapRecoverySession[],
  pair: readonly [string, string],
): WeekSwapRecoveryResult {
  const unverifiable: WeekSwapRecoveryResult = {
    ok: false,
    reason: "recovery_unverifiable",
    violations: [],
  };
  const keys = new Set<string>();
  const dates = new Set<string>();
  for (const session of sessions) {
    const timestamp = Date.parse(`${session.date}T00:00:00.000Z`);
    if (
      !session.key.trim() ||
      keys.has(session.key) ||
      dates.has(session.date) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(session.date) ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== session.date ||
      session.regions.some((region) => !["upper", "lower", "core"].includes(region))
    ) {
      return unverifiable;
    }
    keys.add(session.key);
    dates.add(session.date);
  }
  if (pair[0] === pair[1] || !keys.has(pair[0]) || !keys.has(pair[1])) {
    return unverifiable;
  }

  const first = sessions.find((session) => session.key === pair[0])!;
  const second = sessions.find((session) => session.key === pair[1])!;
  const swapped = sessions
    .map((session) => ({
      ...session,
      date:
        session.key === first.key
          ? second.date
          : session.key === second.key
            ? first.date
            : session.date,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const violations: WeekSwapRecoveryViolation[] = [];
  // Keep every neighbor, including known-empty and core-only sessions. Visit each chronological
  // edge once so a violation between the swapped pair is never duplicated.
  for (let index = 1; index < swapped.length; index += 1) {
    const before = swapped[index - 1];
    const after = swapped[index];
    if (!pair.includes(before.key) && !pair.includes(after.key)) continue;
    const gapDays = (Date.parse(after.date) - Date.parse(before.date)) / 86_400_000;
    const overlap = (["upper", "lower"] as const).filter(
      (region) => before.regions.includes(region) && after.regions.includes(region),
    );
    if (gapDays < 2 && overlap.length > 0) {
      violations.push({ keys: [before.key, after.key], gapDays, overlap });
    }
  }
  return {
    ok: violations.length === 0,
    reason: violations.length === 0 ? null : "recovery_gap_violation",
    violations,
  };
}

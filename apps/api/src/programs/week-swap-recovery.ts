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
  // RED stage: fail closed until the recovery rules are implemented.
  void sessions;
  void pair;
  return { ok: false, reason: "recovery_unverifiable", violations: [] };
}

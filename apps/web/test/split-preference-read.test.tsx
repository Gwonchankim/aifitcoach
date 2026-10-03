import "fake-indexeddb/auto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readThroughReadModel } from "../lib/read-model-cache";
import { sessionDb } from "../components/session/session-db";
import { SplitPreferenceSummary } from "../components/onboarding/SplitPreferenceSummary";

const snapshot = {
  requested_preference: "lower_priority",
  effective_preference: "lower_priority",
  applicable: true,
  reason: null,
  upper_days: 2,
  lower_days: 3,
} as const;
beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});
afterEach(async () => {
  await sessionDb.delete();
});
it("shows effective immutable counts and information-only four-day reason", () => {
  expect(renderToStaticMarkup(<SplitPreferenceSummary snapshot={snapshot} />)).toContain(
    "하체 우선 · 상체 2일 · 하체 3일",
  );
  const four = renderToStaticMarkup(
    <SplitPreferenceSummary
      snapshot={{
        requested_preference: null,
        effective_preference: "balanced",
        applicable: true,
        reason: "four_day_balanced_only",
        upper_days: 2,
        lower_days: 2,
      }}
    />,
  );
  expect(four).toContain("주 4일은 상체 2일·하체 2일로 균형 있게 배치해요.");
  expect(four).not.toContain('role="alert"');
  for (const reason of ["unsupported_days", "legacy_input"] as const) {
    expect(
      renderToStaticMarkup(
        <SplitPreferenceSummary
          snapshot={{
            requested_preference: null,
            effective_preference: null,
            applicable: false,
            reason,
            upper_days: 0,
            lower_days: 0,
          }}
        />,
      ),
    ).toContain("이 계획에는 선호가 적용되지 않았어요");
  }
});
it("preserves the exact snapshot offline and rejects malformed snapshot without falling back to a good cache", async () => {
  const options = { userId: "split-user", kind: "program" as const, cacheKey: "program:current" };
  const program = { program_id: "p", split_preference_snapshot: snapshot, sessions: [] };
  await readThroughReadModel({ ...options, fetcher: async () => program });
  const offline = await readThroughReadModel({
    ...options,
    fetcher: async () => {
      throw new TypeError("offline");
    },
  });
  expect(offline.data).toEqual(program);
  for (const invalid of [
    { ...snapshot, reason: "other" },
    { ...snapshot, effective_preference: "upper_priority" },
  ]) {
    await expect(
      readThroughReadModel({
        ...options,
        fetcher: async () => ({ ...program, split_preference_snapshot: invalid }),
      }),
    ).rejects.toBeInstanceOf(SyntaxError);
  }
});

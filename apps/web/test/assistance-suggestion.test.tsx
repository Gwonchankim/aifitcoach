// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import Dexie from "dexie";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exercise, PlannedSet, Session } from "../lib/api";
import { ExerciseCard, type ExerciseCardProps } from "../components/session/ExerciseCard";
import { assistanceAction, reasonLabel } from "../components/session/set-rules";

const apiMocks = vi.hoisted(() => ({ session: vi.fn(), exercises: vi.fn() }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});
vi.mock("../components/session/sync-coordinator", async () => {
  const actual = await vi.importActual<typeof import("../components/session/sync-coordinator")>(
    "../components/session/sync-coordinator",
  );
  return { ...actual, requestForegroundSync: () => Promise.resolve(null) };
});

const pairs = [
  ["e_assisted_pullup", "e_pullup", "풀업"],
  ["e_assisted_dips", "e_dips", "딥스"],
] as const;
const metadata = (id: string, name: string): Exercise => ({
  id,
  name_ko: name,
  name_en: id,
  primary_muscles: ["chest"],
  movement_pattern: "horizontal_push",
  equipment: "machine",
  difficulty: "beginner",
  mechanic: "compound",
  region: "upper",
  metric: "reps",
  step_kg: 2.5,
  default_time_low_sec: null,
  default_time_high_sec: null,
  substitutions: [],
  media_url: null,
});
const catalog = pairs.flatMap(([id, target, name]) => [
  metadata(id, `어시스트 ${name}`),
  metadata(target, name),
]);
const catalogById = new Map(catalog.map((exercise) => [exercise.id, exercise]));
const minimum = (id: string, target: string, patch: Partial<PlannedSet> = {}): PlannedSet =>
  ({
    id: `${id}-set`,
    exercise_id: id,
    set_no: 1,
    target_reps_low: 8,
    target_reps_high: 12,
    target_rir: 2,
    rest_sec: 90,
    recommended_weight: 2.5,
    recommended_reps: 8,
    reason_code: "ASSISTANCE_MINIMUM_REACHED",
    confidence: 0.85,
    rules_version: "2026.08.2",
    load_kind: "assistance",
    recommendation_state: "ready",
    assistance_provenance: "native",
    recommended_action: { kind: "suggest_exercise_swap", exercise_id: target },
    assistance_safety_status: "safe",
    recommendation_gate: "ready",
    performed_set: null,
    ...patch,
  }) as PlannedSet;
const cardProps = (set: PlannedSet): ExerciseCardProps => ({
  name: "어시스트 운동",
  exercise: catalogById.get(set.exercise_id) ?? null,
  catalogById,
  sets: [set],
  drafts: {},
  readOnly: false,
  lockedReason: null,
  painScore: null,
  expandedSetId: null,
  onToggleExpand: vi.fn(),
  onEdit: vi.fn(),
  onSwap: vi.fn(),
  onRemove: vi.fn(),
  onRemoveBlocked: vi.fn(),
  onReportPain: vi.fn(),
  onComplete: vi.fn(),
  onUncomplete: vi.fn(),
});
afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
});

describe("D01 actual recommendation card", () => {
  it.each(pairs)(
    "%s consumes the authoritative %s action as passive canonical %s text",
    (id, target, name) => {
      const props = cardProps(minimum(id, target));
      render(<ExerciseCard {...props} />);
      const suggestion = screen.getByText(
        `다음 단계로 ${name}${name === "딥스" ? "를" : "을"} 고려해 보세요`,
      );
      expect(suggestion.closest("button,a")).toBeNull();
      expect(screen.queryByRole("button", { name: /다음 단계|고려해/ })).toBeNull();
      expect(props.onSwap).not.toHaveBeenCalled();
      expect(screen.getByText("도움을 더 줄이기 어려워요. 현재 도움 무게를 유지해요")).toBeTruthy();
      expect(screen.getAllByText("도움 2.5kg").length).toBeGreaterThan(0);
    },
  );
  it("uses the actual catalog name and never an ID-derived fallback", () => {
    const props = cardProps(minimum("e_assisted_dips", "e_dips"));
    const view = render(
      <ExerciseCard
        {...props}
        catalogById={new Map([["e_dips", metadata("e_dips", "카탈로그의 딥스 이름")]])}
      />,
    );
    expect(screen.getByText("다음 단계로 카탈로그의 딥스 이름을 고려해 보세요")).toBeTruthy();
    view.rerender(<ExerciseCard {...props} catalogById={new Map()} />);
    expect(screen.queryByText(/다음 단계로/)).toBeNull();
    view.rerender(<ExerciseCard {...props} catalogById={undefined} />);
    expect(screen.queryByText(/다음 단계로/)).toBeNull();
  });
  it.each([
    ["null action", { recommended_action: null }],
    [
      "unknown target",
      { recommended_action: { kind: "suggest_exercise_swap", exercise_id: "unknown" } },
    ],
    [
      "wrong pullup target",
      { recommended_action: { kind: "suggest_exercise_swap", exercise_id: "e_pullup" } },
    ],
    ["external snapshot", { load_kind: "external" }],
    ["unknown source", { exercise_id: "unknown" }],
    ["missing source", { exercise_id: undefined }],
    ["nonminimum", { reason_code: "ASSISTANCE_DOWN_REP_TARGET_MET" }],
    ["pain", { recommendation_state: "substitution_required", reason_code: "SUBSTITUTE_PAIN" }],
    ["invalid", { recommendation_state: "unavailable", reason_code: "INVALID_INPUT" }],
    ["calibration", { recommendation_state: "calibration_needed" }],
    ["unsafe", { assistance_safety_status: "unsafe" }],
    ["missing safety", { assistance_safety_status: undefined }],
    ["zero samples", { recommendation_gate: "no_history" }],
    ["one sample", { recommendation_gate: "early" }],
    ["two samples", { recommendation_gate: "early" }],
  ])(
    "hides concrete target for %s even when a minimum action is incorrectly supplied",
    (_label, patch) => {
      const set = minimum("e_assisted_dips", "e_dips", patch as Partial<PlannedSet>);
      expect(assistanceAction(set)).toBeNull();
      render(<ExerciseCard {...cardProps(set)} />);
      expect(screen.queryByText(/다음 단계로/)).toBeNull();
    },
  );
  it("null minimum action retains only neutral weight-maintenance copy", () => {
    const set = minimum("e_assisted_dips", "e_dips", { recommended_action: null });
    expect(reasonLabel(set.reason_code!, "weighted", set)).toBe(
      "도움을 더 줄이기 어려워요. 현재 도움 무게를 유지해요",
    );
  });
});

describe("D01 actual SessionScreen and durable mirror", () => {
  it.each([
    ["sample0", { recommendation_gate: "no_history", recommended_weight: null, reason_code: null }],
    ["sample1", { recommendation_gate: "early", recommended_weight: null, reason_code: null }],
    ["sample2", { recommendation_gate: "early", recommended_weight: null, reason_code: null }],
    ["null action", { recommended_action: null }],
    [
      "unknown target",
      { recommended_action: { kind: "suggest_exercise_swap", exercise_id: "unknown" } },
    ],
    [
      "external snapshot",
      { load_kind: "external", assistance_safety_status: null, assistance_provenance: null },
    ],
  ])(
    "mirror/reload preserves the actual %s wire while the screen hides the concrete target",
    async (_label, patch) => {
      vi.resetModules();
      Dexie.dependencies.indexedDB = new IDBFactory();
      const { sessionDb, DEV_USER_SCOPE, readThroughSession, mirrorCatalog } =
        await import("../components/session/session-db");
      const { SessionScreen } = await import("../components/session/SessionScreen");
      const payload = {
        id: "gated-mirror-suggestion",
        goal: "hypertrophy",
        status: "scheduled",
        scheduled_date: "2026-08-14",
        planned_sets: [minimum("e_assisted_dips", "e_dips", patch as Partial<PlannedSet>)],
      } as unknown as Session;
      await readThroughSession(DEV_USER_SCOPE, payload.id, async () => payload);
      await mirrorCatalog(DEV_USER_SCOPE, catalog);
      const before = await sessionDb.sessions.get([DEV_USER_SCOPE, payload.id]);
      sessionDb.close();
      await sessionDb.open();
      apiMocks.session.mockRejectedValue(new TypeError("offline"));
      apiMocks.exercises.mockRejectedValue(new TypeError("offline"));
      onlineManager.setOnline(false);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const view = render(
        <QueryClientProvider client={client}>
          <SessionScreen sessionId={payload.id} />
        </QueryClientProvider>,
      );
      expect(await screen.findByRole("heading", { name: "어시스트 딥스" })).toBeTruthy();
      expect(screen.queryByText(/다음 단계로/)).toBeNull();
      if (_label.startsWith("sample")) expect(screen.queryByText("도움 2.5kg")).toBeNull();
      expect(await sessionDb.sessions.get([DEV_USER_SCOPE, payload.id])).toEqual(before);
      expect(await sessionDb.outbox.toArray()).toEqual([]);
      view.unmount();
      client.clear();
      sessionDb.close();
    },
  );
  it.each(pairs)(
    "%s keeps its %s action through authoritative write, close/reopen and offline render",
    async (id, target, name) => {
      vi.resetModules();
      Dexie.dependencies.indexedDB = new IDBFactory();
      const { sessionDb, DEV_USER_SCOPE, readThroughSession, mirrorCatalog } =
        await import("../components/session/session-db");
      const { SessionScreen } = await import("../components/session/SessionScreen");
      const set = minimum(id, target);
      const payload = {
        id: `suggestion-${id}`,
        goal: "hypertrophy",
        status: "scheduled",
        scheduled_date: "2026-08-14",
        planned_sets: [set],
      } as unknown as Session;
      const read = await readThroughSession(DEV_USER_SCOPE, payload.id, async () => payload);
      expect(read).toEqual(payload);
      await mirrorCatalog(DEV_USER_SCOPE, catalog);
      const before = await sessionDb.sessions.get([DEV_USER_SCOPE, payload.id]);
      sessionDb.close();
      await sessionDb.open();
      apiMocks.session.mockRejectedValue(new TypeError("offline"));
      apiMocks.exercises.mockRejectedValue(new TypeError("offline"));
      onlineManager.setOnline(false);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const view = render(
        <QueryClientProvider client={client}>
          <SessionScreen sessionId={payload.id} />
        </QueryClientProvider>,
      );
      expect(
        await screen.findByText(
          `다음 단계로 ${name}${name === "딥스" ? "를" : "을"} 고려해 보세요`,
        ),
      ).toBeTruthy();
      await waitFor(() => expect(client.getQueryData(["session", payload.id])).toEqual(payload));
      expect(await sessionDb.sessions.get([DEV_USER_SCOPE, payload.id])).toEqual(before);
      expect(await sessionDb.outbox.toArray()).toEqual([]);
      view.unmount();
      client.clear();
      sessionDb.close();
    },
  );
  it("cold catalog pending and failure never guess a target name; arriving catalog renders the canonical name", async () => {
    vi.resetModules();
    Dexie.dependencies.indexedDB = new IDBFactory();
    const { sessionDb } = await import("../components/session/session-db");
    const { SessionScreen } = await import("../components/session/SessionScreen");
    const payload = {
      id: "cold-suggestion",
      goal: "hypertrophy",
      status: "scheduled",
      scheduled_date: "2026-08-14",
      planned_sets: [minimum("e_assisted_dips", "e_dips")],
    } as unknown as Session;
    apiMocks.session.mockResolvedValue(payload);
    let reject!: (error: Error) => void;
    apiMocks.exercises.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const view = render(
      <QueryClientProvider client={client}>
        <SessionScreen sessionId={payload.id} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("운동 목록을 불러오는 중이에요.")).toBeTruthy();
    expect(screen.queryByText(/다음 단계로/)).toBeNull();
    reject(new TypeError("offline"));
    expect(await screen.findByRole("button", { name: "다시 시도" })).toBeTruthy();
    expect(screen.queryByText(/다음 단계로/)).toBeNull();
    apiMocks.exercises.mockResolvedValue({ items: catalog, next_cursor: null });
    await client.refetchQueries({ queryKey: ["exercises"] });
    expect(await screen.findByText("다음 단계로 딥스를 고려해 보세요")).toBeTruthy();
    view.unmount();
    client.clear();
    sessionDb.close();
  });
});

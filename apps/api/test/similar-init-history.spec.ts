import { recommendNextSet } from "shared";
import type { PrismaService } from "../src/prisma/prisma.service";
import {
  RecommendationService,
  NO_HISTORY,
  type ExerciseHistory,
  type ExerciseSpec,
} from "../src/recommendation/recommendation.service";

jest.mock("shared", () => {
  const actual = jest.requireActual<typeof import("shared")>("shared");
  return { ...actual, recommendNextSet: jest.fn(actual.recommendNextSet) };
});

const USER = "owner";
const TARGET = "e_incline_bench_press";
const SOURCE = "e_bench_press";
const spec = (
  exerciseId = TARGET,
  loadSemantics: ExerciseSpec["loadSemantics"] = "external_load",
) => ({ exerciseId, loadSemantics });

function row(
  exerciseId: string,
  options: {
    userId?: string;
    semantics?: string;
    reps?: number;
    weight?: number;
    day?: number;
    completed?: boolean;
    status?: string;
    sessionId?: string;
    completedAt?: Date;
  } = {},
) {
  const day = options.day ?? 1;
  return {
    id: exerciseId + day,
    actualWeight: String(options.weight ?? 60),
    actualReps: options.reps ?? 10,
    actualRir: 2,
    actualTimeSec: null,
    painScore: null,
    performedAt: new Date(Date.UTC(2026, 7, day, 12)),
    completed: options.completed ?? true,
    plannedSet: {
      exerciseId,
      setNo: 1,
      loadSemantics: options.semantics ?? "external_load",
      sessionId: options.sessionId ?? exerciseId + day,
      session: {
        scheduledDate: new Date(Date.UTC(2026, 7, day)),
        completedAt: options.completedAt ?? new Date(Date.UTC(2026, 7, day, 12)),
        status: options.status ?? "completed",
        program: { userId: options.userId ?? USER },
      },
    },
  };
}

type PlannedFilter = {
  exerciseId?: string | { in: string[] };
  loadSemantics?: string;
  session?: { status?: string; program?: { userId?: string } };
};
type Query = {
  where: { completed?: boolean; OR?: { plannedSet: PlannedFilter }[]; plannedSet?: PlannedFilter };
};

/** A query-aware repository double: omitting tenancy/semantics really returns the forbidden rows. */
function harness(rows: ReturnType<typeof row>[], bias?: number) {
  const findMany = jest.fn(async ({ where }: Query) =>
    rows.filter((r) => {
      const matches = (p: PlannedFilter) =>
        (p.exerciseId === undefined ||
          (typeof p.exerciseId === "string"
            ? p.exerciseId === r.plannedSet.exerciseId
            : p.exerciseId.in.includes(r.plannedSet.exerciseId))) &&
        (p.loadSemantics === undefined || p.loadSemantics === r.plannedSet.loadSemantics) &&
        (p.session?.status === undefined || p.session.status === r.plannedSet.session.status) &&
        (p.session?.program?.userId === undefined ||
          p.session.program.userId === r.plannedSet.session.program.userId);
      return (
        (where.completed === undefined || where.completed === r.completed) &&
        (where.OR
          ? where.OR.some((branch) => matches(branch.plannedSet))
          : matches(where.plannedSet ?? {}))
      );
    }),
  );
  const findUnique = jest.fn(async () =>
    bias === undefined ? null : { status: "graduated", biasOverall: bias },
  );
  const client = {
    performedSet: { findMany },
    userRirCalibration: { findUnique },
    assistanceAudit: { createMany: jest.fn() },
  };
  return {
    service: new RecommendationService(client as unknown as PrismaService),
    client,
    findMany,
    findUnique,
  };
}

describe("similar history input", () => {
  it("① attaches exact source/ratio/e1RM from the latest completed session and forwards it", async () => {
    const h = harness([
      row(SOURCE, { weight: 100 }),
      row(SOURCE, { day: 2 }),
      row(SOURCE, { day: 3, weight: 200, status: "scheduled" }),
      row(SOURCE, { day: 4, weight: 300, completed: false }),
    ]);
    const history = (await h.service.prefetchHistories(USER, [spec()])).get(TARGET)!;
    expect(history).toEqual({
      lastSets: [],
      similar: { source_exercise_id: SOURCE, source_e1rm: 84, ratio: 0.8 },
    });
    expect(
      h.service.recommend({
        goal: "hypertrophy",
        exercise: {
          id: TARGET,
          mechanic: "compound",
          region: "upper",
          metric: "reps",
          loadSemantics: "external_load",
          defaultStepKg: null,
        },
        target: { reps_low: 8, reps_high: 12, rir: 2 },
        history,
      }),
    ).toBeDefined();
    expect(jest.mocked(recommendNextSet).mock.calls.at(-1)?.[0]).toHaveProperty("similar", {
      source_exercise_id: SOURCE,
      source_e1rm: 84,
      ratio: 0.8,
    });
    expect(NO_HISTORY).toEqual({ lastSets: [] });
  });

  it.each([10, 0])(
    "② target history, including invalid reps %i, never attaches similar",
    async (reps) => {
      const h = harness([row(TARGET, { reps }), row(SOURCE)]);
      expect((await h.service.prefetchHistories(USER, [spec()])).get(TARGET)).not.toHaveProperty(
        "similar",
      );
      expect(h.findMany).toHaveBeenCalledTimes(1);
      expect(h.findUnique).not.toHaveBeenCalled();
    },
  );

  it("③ assistance target never attaches or forwards similar", async () => {
    const h = harness([row(SOURCE)]);
    const history = (await h.service.prefetchHistories(USER, [spec(TARGET, "assistance")])).get(
      TARGET,
    )!;
    expect(history).not.toHaveProperty("similar");
    expect(h.findUnique).not.toHaveBeenCalled();
    h.service.recommend({
      goal: "hypertrophy",
      exercise: {
        id: TARGET,
        mechanic: "compound",
        region: "upper",
        metric: "reps",
        loadSemantics: "assistance",
        defaultStepKg: null,
      },
      target: { reps_low: 8, reps_high: 12, rir: 2 },
      history: {
        ...history,
        similar: { source_exercise_id: SOURCE, source_e1rm: 84, ratio: 0.8 },
      } as ExerciseHistory,
    });
    expect(jest.mocked(recommendNextSet).mock.calls.at(-1)?.[0]).not.toHaveProperty("similar");
  });

  it("④ tenancy: other user's source cannot initialize a target", async () => {
    const h = harness([row(SOURCE, { userId: "other" })]);
    expect((await h.service.prefetchHistories(USER, [spec()])).get(TARGET)).not.toHaveProperty(
      "similar",
    );
    expect(h.findMany).toHaveBeenCalledTimes(2);
    for (const branch of h.findMany.mock.calls[1][0].where.OR!)
      expect(branch.plannedSet.session?.program).toEqual({ userId: USER });
  });

  it("⑤ semantics: assistance source facts are excluded", async () => {
    const h = harness([row(SOURCE, { semantics: "assistance" })]);
    expect((await h.service.prefetchHistories(USER, [spec()])).get(TARGET)).not.toHaveProperty(
      "similar",
    );
    expect(h.findMany).toHaveBeenCalledTimes(2);
    for (const branch of h.findMany.mock.calls[1][0].where.OR!)
      expect(branch.plannedSet.loadSemantics).toBe("external_load");
  });

  it.each(["missing", "zero-reps", "zero-weight"])(
    "⑥ fallback after first candidate %s",
    async (invalid) => {
      const rows = [row("e_decline_bench_press")];
      if (invalid !== "missing")
        rows.push(
          row(TARGET, {
            reps: invalid === "zero-reps" ? 0 : 10,
            weight: invalid === "zero-weight" ? 0 : 60,
          }),
        );
      // An older valid first-candidate session must not rescue its invalid latest session.
      if (invalid === "zero-reps") rows.push(row(TARGET, { day: 0 }));
      const h = harness(rows);
      expect((await h.service.prefetchHistories(USER, [spec(SOURCE)])).get(SOURCE)).toHaveProperty(
        "similar",
        {
          source_exercise_id: "e_decline_bench_press",
          source_e1rm: 84,
          ratio: 0.8,
        },
      );
    },
  );

  it("⑦ whitelist priority wins over recency between valid candidates", async () => {
    const h = harness([row("e_decline_bench_press", { day: 2, weight: 100 }), row(TARGET)]);
    expect((await h.service.prefetchHistories(USER, [spec(SOURCE)])).get(SOURCE)).toHaveProperty(
      "similar.source_exercise_id",
      TARGET,
    );
  });

  it("⑧ unknown target makes no source or calibration query", async () => {
    const h = harness([row(SOURCE)]);
    expect((await h.service.prefetchHistories(USER, [spec("unknown")])).get("unknown")).toEqual(
      NO_HISTORY,
    );
    expect(h.findMany).toHaveBeenCalledTimes(1);
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it("⑨ batches the source union: performed ≤3, calibration ≤1, on the supplied client", async () => {
    const root = harness([]),
      tx = harness([row(SOURCE)]);
    const specs = [
      spec(),
      spec("e_decline_bench_press"),
      spec("e_assisted_pullup", "assistance"),
      spec(),
    ];
    const map = await root.service.prefetchHistories(
      USER,
      specs,
      tx.client as unknown as PrismaService,
    );
    expect(map.size).toBe(3);
    expect(tx.findMany).toHaveBeenCalledTimes(3);
    expect(tx.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.findUnique).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(tx.findMany.mock.calls[2][0].where.OR?.map((b) => b.plannedSet.exerciseId)).toEqual([
      { in: [SOURCE] },
    ]);
    expect(root.findMany).not.toHaveBeenCalled();
    expect(root.findUnique).not.toHaveBeenCalled();
  });

  it("single and batch paths apply calibration bias and latest-session tie ordering identically", async () => {
    const h = harness(
      [row(SOURCE, { sessionId: "a", weight: 100 }), row(SOURCE, { sessionId: "z" })],
      1,
    );
    const single = await h.service.historyFor(USER, TARGET);
    const batch = (await h.service.prefetchHistories(USER, [spec()])).get(TARGET);
    expect(single).toEqual(batch);
    expect(single).toHaveProperty("similar.source_e1rm", 86);
  });

  it("all invalid candidates leave similar absent and empty specs perform no queries", async () => {
    const h = harness([row(TARGET, { reps: 0 }), row("e_decline_bench_press", { weight: 0 })]);
    expect((await h.service.prefetchHistories(USER, [spec(SOURCE)])).get(SOURCE)).toEqual(
      NO_HISTORY,
    );
    h.findMany.mockClear();
    h.findUnique.mockClear();
    expect(await h.service.prefetchHistories(USER, [])).toEqual(new Map());
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it("single and batch histories agree when target facts have mixed load semantics", async () => {
    const h = harness([row(TARGET, { semantics: "assistance" }), row(SOURCE)]);
    const single = await h.service.historyFor(USER, TARGET, "external_load");
    const batch = (await h.service.prefetchHistories(USER, [spec()])).get(TARGET);
    expect(single).toEqual(batch);
    expect(single).toHaveProperty("similar.source_e1rm", 84);
    expect(single.lastSets).toEqual([]);
  });
});

/**
 * F-3 final fixup — forward migration 의 **되돌릴 수 없는 경로**를 실제로 실행한다
 * (최종 독립 재리뷰 P2-2).
 *
 * 적용된 DB 에서는 `.08.1/native` 삽입이 matrix CHECK 로 막히므로, preflight 와 두 재분류
 * UPDATE 는 post-migration fixture 로 검증할 수 없다. 그래서 일회용 DB 에 original 까지만
 * 올린 pre-fixup 상태를 만들고 **실제 SQL 파일 전체**를 적용한다.
 *
 * **테스트용 preflight/correction 재작성은 하지 않는다** — 파일을 읽어 그대로 쓴다.
 */
import type { PrismaClient } from "@prisma/client";
import {
  FORWARD_MIGRATION,
  forwardMigrationSql,
  withPreFixupDatabase,
} from "./support/forward-migration-probe";

const ASSISTED = "e_assisted_pullup";
const PROBE_TIMEOUT = 180_000;

/** 이 실행 안에서만 유효한 라벨 — 다른 실행의 DB 를 건드리지 않는다. */
function label(scenario: string): string {
  const run = (process.env.AFC_TEST_RUN_ID ?? "local").replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return `${run}_${scenario}`.toLowerCase();
}

function baseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 이 필요하다(globalSetup 이 test DB 로 설정한다).");
  return url;
}

/** pre-fixup 상태에 `.08.1/native` 와 unknown 버전 행을 심는다. */
async function seedPreFixup(
  prisma: PrismaClient,
  rows: { rulesVersion: string; performed: boolean; key: string }[],
): Promise<Map<string, string>> {
  const userId = "00000000-0000-4000-8000-0000000f3aaa";
  // 카탈로그는 시드하지 않는다 — 이 harness 가 필요로 하는 한 종목만 만든다.
  await prisma.exercise.create({
    data: {
      id: ASSISTED,
      nameKo: "어시스트 풀업",
      nameEn: "Assisted Pull-up",
      movementPattern: "vertical_pull",
      mechanic: "compound",
      region: "upper",
      primaryMuscles: ["lats"],
      secondaryMuscles: [],
      equipment: "machine",
      difficulty: "beginner",
      metric: "reps",
      defaultRepsLow: 8,
      defaultRepsHigh: 12,
      defaultStepKg: "2.50",
      loadSemantics: "assistance",
      unilateral: false,
      substitutions: [],
      cues: [],
      media: {},
    },
  });
  await prisma.user.create({
    data: {
      id: userId,
      sex: "other",
      birthYear: 1995,
      heightCm: 175,
      weightKg: 75,
      goal: "hypertrophy",
      experienceLevel: "intermediate",
      constraints: {},
    },
  });
  const program = await prisma.program.create({
    data: {
      userId,
      goal: "hypertrophy",
      daysPerWeek: 3,
      minutesPerDay: 60,
      splitType: "full_body",
      rulesVersion: "2026.08.1",
      startedAt: new Date("2026-08-03T00:00:00Z"),
      totalWeeks: 12,
      status: "active",
      generationInput: {},
      template: [],
      excludedExercises: [],
    },
  });
  const session = await prisma.workoutSession.create({
    data: {
      programId: program.id,
      scheduledDate: new Date("2026-08-03T00:00:00Z"),
      focus: "full_body",
      status: "scheduled",
    },
  });

  const ids = new Map<string, string>();
  for (const [index, row] of rows.entries()) {
    // pre-fixup 상태에는 matrix CHECK 가 없어 `.08.1/native` 가 들어간다 — 그게 이 harness 의 요점이다.
    const planned = await prisma.plannedSet.create({
      data: {
        sessionId: session.id,
        exerciseId: ASSISTED,
        orderIndex: 0,
        setNo: index + 1,
        targetRepsLow: 8,
        targetRepsHigh: 12,
        targetRir: 2,
        restSec: 90,
        recommendedWeight: "42.50",
        recommendedReps: 8,
        reasonCode: "WEIGHT_UP_REP_TARGET_MET",
        confidence: "0.85",
        rulesVersion: row.rulesVersion,
        loadSemantics: "assistance",
        assistanceStepKg: "2.50",
        assistanceProvenance: "native",
      },
    });
    ids.set(row.key, planned.id);
    if (row.performed) {
      await prisma.performedSet.create({
        data: {
          plannedSetId: planned.id,
          actualWeight: "20",
          actualReps: 12,
          actualRir: 2,
          completed: true,
          clientId: `00000000-0000-4000-8000-00000000000${index + 1}`,
          performedAt: new Date("2026-08-03T10:00:00Z"),
        },
      });
    }
  }
  return ids;
}

async function ddlState(prisma: PrismaClient): Promise<{ checks: string[]; triggers: string[] }> {
  const checks = await prisma.$queryRawUnsafe<{ conname: string }[]>(
    "select conname from pg_constraint where conname like 'ck_planned_assistance%' order by conname",
  );
  const triggers = await prisma.$queryRawUnsafe<{ tgname: string }[]>(
    "select tgname from pg_trigger where tgname = 'trg_planned_assistance_snapshot_immutable'",
  );
  return { checks: checks.map((c) => c.conname), triggers: triggers.map((t) => t.tgname) };
}

/** 정상 경로의 관측 결과. mutation 이 이 값을 바꾸지 못하면 테스트가 아무것도 방어하지 못한다. */
const HEALTHY = {
  applied: true,
  performed: "legacy_performed/2026.08.1/42.5",
  unperformed: "remediated/2026.08.2/null",
};

async function observe(
  prisma: PrismaClient,
  applyForward: (sql: string) => { forwardApplied: boolean },
  sql: string,
  ids: Map<string, string>,
): Promise<typeof HEALTHY> {
  const applied = applyForward(sql).forwardApplied;
  const describeRow = async (key: string): Promise<string> => {
    const row = await prisma.plannedSet.findUniqueOrThrow({ where: { id: ids.get(key)! } });
    const weight = row.recommendedWeight === null ? "null" : String(Number(row.recommendedWeight));
    return `${row.assistanceProvenance}/${row.rulesVersion}/${weight}`;
  };
  return {
    applied,
    performed: await describeRow("performed"),
    unperformed: await describeRow("unperformed"),
  };
}

describe("forward migration 실제 실행 — pre-fixup 일회용 DB", () => {
  it(
    "정상 경로: performed → legacy_performed, unperformed → .08.2/remediated + 처방 교정",
    async () => {
      await withPreFixupDatabase(baseUrl(), label("ok"), async ({ prisma, applyForward }) => {
        const ids = await seedPreFixup(prisma, [
          { key: "performed", rulesVersion: "2026.08.1", performed: true },
          { key: "unperformed", rulesVersion: "2026.08.1", performed: false },
        ]);

        // pre-fixup 상태에는 matrix CHECK 도 trigger 도 없다.
        const before = await ddlState(prisma);
        expect(before.checks).not.toContain("ck_planned_assistance_version_matrix");
        expect(before.triggers).toEqual([]);

        const result = applyForward(forwardMigrationSql());
        expect(result.failure ?? "").toBe("");
        expect(result.forwardApplied).toBe(true);

        const performed = await prisma.plannedSet.findUniqueOrThrow({
          where: { id: ids.get("performed")! },
        });
        const unperformed = await prisma.plannedSet.findUniqueOrThrow({
          where: { id: ids.get("unperformed")! },
        });

        // 수행된 행은 사실이라 `.08.1` 을 유지한다. 처방도 그대로다.
        expect(performed.assistanceProvenance).toBe("legacy_performed");
        expect(performed.rulesVersion).toBe("2026.08.1");
        expect(Number(performed.recommendedWeight)).toBe(42.5);
        expect(performed.reasonCode).toBe("WEIGHT_UP_REP_TARGET_MET");

        // 미수행 행만 보정한다 — 무게 미정 + 캘리브레이션 요청.
        expect(unperformed.assistanceProvenance).toBe("remediated");
        expect(unperformed.rulesVersion).toBe("2026.08.2");
        expect(unperformed.recommendedWeight).toBeNull();
        expect(unperformed.reasonCode).toBe("ASSISTANCE_CALIBRATION_NEEDED");
        expect(Number(unperformed.confidence)).toBe(0);

        // audit 은 두 행 모두에 남는다.
        const audits = await prisma.assistanceAudit.findMany({ orderBy: { action: "asc" } });
        expect(audits.map((a) => a.action).sort()).toEqual(["legacy_performed", "remediated"]);
        expect(JSON.stringify(audits)).not.toMatch(/pain|v1:/i);

        // DDL post-state.
        const after = await ddlState(prisma);
        expect(after.checks).toEqual([
          "ck_planned_assistance_matches_semantics",
          "ck_planned_assistance_snapshot",
          "ck_planned_assistance_version_matrix",
        ]);
        expect(after.triggers).toEqual(["trg_planned_assistance_snapshot_immutable"]);

        // migration history 에 forward 가 기록된다.
        const history = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
          `select migration_name from _prisma_migrations where migration_name = '${FORWARD_MIGRATION}'`,
        );
        expect(history).toHaveLength(1);
      });
    },
    PROBE_TIMEOUT,
  );

  it(
    "unknown rules version 은 preflight 에서 막히고 correction·DDL 이 0 이다",
    async () => {
      await withPreFixupDatabase(baseUrl(), label("unknown"), async ({ prisma, applyForward }) => {
        const ids = await seedPreFixup(prisma, [
          { key: "unknown", rulesVersion: "9999.99.9", performed: false },
          { key: "unperformed", rulesVersion: "2026.08.1", performed: false },
        ]);

        const result = applyForward(forwardMigrationSql());
        expect(result.forwardApplied).toBe(false);
        expect(result.failure).toContain("지원하지 않는 rules_version");

        // migration 전체가 하나의 트랜잭션이라 **아무것도 바뀌지 않아야 한다.**
        const unknown = await prisma.plannedSet.findUniqueOrThrow({
          where: { id: ids.get("unknown")! },
        });
        const unperformed = await prisma.plannedSet.findUniqueOrThrow({
          where: { id: ids.get("unperformed")! },
        });
        expect(unknown.assistanceProvenance).toBe("native");
        expect(unperformed.assistanceProvenance).toBe("native");
        expect(unperformed.rulesVersion).toBe("2026.08.1");
        expect(Number(unperformed.recommendedWeight)).toBe(42.5);
        expect(await prisma.assistanceAudit.count()).toBe(0);

        const after = await ddlState(prisma);
        expect(after.checks).not.toContain("ck_planned_assistance_version_matrix");
        expect(after.triggers).toEqual([]);
      });
    },
    PROBE_TIMEOUT,
  );
});

/**
 * SQL mutation — **repo 의 migration 파일은 건드리지 않는다.** 읽은 내용을 변형해 일회용 DB 의
 * 임시 사본에만 쓴다. 원본을 고치면 jest globalSetup 의 `migrate deploy` 가 `afc_test` 에서
 * checksum 불일치로 스위트 전체를 깨뜨린다.
 */
describe("forward migration mutation — 고의 주입 → red", () => {
  const mutations: Array<[string, (sql: string) => string, string]> = [
    [
      "performed EXISTS 반전",
      (sql) =>
        sql.replace(
          'AND EXISTS (SELECT 1 FROM "performed_sets"',
          'AND NOT EXISTS (SELECT 1 FROM "performed_sets"',
        ),
      "ok",
    ],
    [
      "unperformed NOT EXISTS 반전",
      (sql) =>
        sql.replace(
          'AND NOT EXISTS (SELECT 1 FROM "performed_sets"',
          'AND EXISTS (SELECT 1 FROM "performed_sets"',
        ),
      "ok",
    ],
  ];

  it.each(mutations)(
    "%s → 관측 결과가 정상과 달라진다",
    async (name, mutate, scenario) => {
      const original = forwardMigrationSql();
      const mutated = mutate(original);
      // 이름이 바뀌어 치환이 조용히 no-op 되면 mutation 이 아무것도 증명하지 못한다.
      expect(mutated).not.toBe(original);

      await withPreFixupDatabase(
        baseUrl(),
        label(`mut${mutations.findIndex((m) => m[0] === name)}`),
        async ({ prisma, applyForward }) => {
          const ids = await seedPreFixup(prisma, [
            { key: "performed", rulesVersion: "2026.08.1", performed: true },
            { key: "unperformed", rulesVersion: "2026.08.1", performed: false },
            ...(scenario === "unknown"
              ? [{ key: "unknown", rulesVersion: "9999.99.9", performed: false }]
              : []),
          ]);

          const observed = await observe(prisma, applyForward, mutated, ids);
          expect(observed).not.toEqual(HEALTHY);
        },
      );
    },
    PROBE_TIMEOUT,
  );

  it(
    "대조: 변형하지 않은 실제 SQL 은 정상 결과를 낸다",
    async () => {
      await withPreFixupDatabase(baseUrl(), label("control"), async ({ prisma, applyForward }) => {
        const ids = await seedPreFixup(prisma, [
          { key: "performed", rulesVersion: "2026.08.1", performed: true },
          { key: "unperformed", rulesVersion: "2026.08.1", performed: false },
        ]);
        expect(await observe(prisma, applyForward, forwardMigrationSql(), ids)).toEqual(HEALTHY);
      });
    },
    PROBE_TIMEOUT,
  );
});

/**
 * preflight mutation 의 oracle.
 *
 * **이전 oracle 은 공허했다.** unknown fixture 는 unknown 행이 없는 `HEALTHY` 와 **어차피 다르다** —
 * 변형하지 않은 실제 SQL 로 돌려도 다르다. 그래서 `observed !== HEALTHY` 는 preflight 를 지웠든
 * 주석 한 줄만 바꿨든 항상 통과했다. **주석만 바꾸는 무해한 변형도 "검출"로 세어졌다.**
 *
 * 기준을 바꾼다: **같은 seed 에 변형하지 않은 실제 SQL 을 적용한 control observation** 이다.
 *   - harmless(주석만) → control 과 **exact 동일**해야 한다. 이건 mutation kill 이 아니다.
 *   - removed(preflight 제거) → **failure 의 출처가 달라야** 한다.
 *
 * migration 전체가 한 트랜잭션이라 preflight 를 지워도 row·audit·DDL 은 control 과 같을 수 있다
 * (뒤의 matrix CHECK 가 대신 막고 전부 롤백된다). 그래서 **error provenance 를 명시적으로** 본다 —
 * "내 preflight 가 막았나, 아니면 CHECK 까지 흘러갔나".
 */
/** 주석을 걷어낸 실행 SQL. 설명 문구에도 같은 한국어가 있어 원문으로 판정하면 틀린다. */
function executableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

type FailureKind = "none" | "custom_preflight" | "version_matrix" | "other";

interface UnknownObservation {
  forwardApplied: boolean;
  failure: FailureKind;
  unknown: string;
  performed: string;
  unperformed: string;
  auditCount: number;
  matrixCheck: boolean;
  trigger: boolean;
}

/** 실패의 출처만 남긴다. temp 경로·checksum 같은 비의미 값은 비교에서 제외한다. */
function failureKind(applied: boolean, output: string | undefined): FailureKind {
  if (applied) return "none";
  const text = output ?? "";
  if (text.includes("지원하지 않는 rules_version")) return "custom_preflight";
  if (text.includes("ck_planned_assistance_version_matrix")) return "version_matrix";
  return "other";
}

async function observeUnknown(sql: string, scenario: string): Promise<UnknownObservation> {
  return withPreFixupDatabase(
    baseUrl(),
    label(scenario),
    async ({ prisma, applyForward }): Promise<UnknownObservation> => {
      const ids = await seedPreFixup(prisma, [
        { key: "performed", rulesVersion: "2026.08.1", performed: true },
        { key: "unperformed", rulesVersion: "2026.08.1", performed: false },
        { key: "unknown", rulesVersion: "9999.99.9", performed: false },
      ]);
      const result = applyForward(sql);
      const describeRow = async (key: string): Promise<string> => {
        const row = await prisma.plannedSet.findUniqueOrThrow({ where: { id: ids.get(key)! } });
        const weight =
          row.recommendedWeight === null ? "null" : String(Number(row.recommendedWeight));
        return `${row.assistanceProvenance}/${row.rulesVersion}/${weight}`;
      };
      const ddl = await ddlState(prisma);
      return {
        forwardApplied: result.forwardApplied,
        failure: failureKind(result.forwardApplied, result.failure),
        unknown: await describeRow("unknown"),
        performed: await describeRow("performed"),
        unperformed: await describeRow("unperformed"),
        auditCount: await prisma.assistanceAudit.count(),
        matrixCheck: ddl.checks.includes("ck_planned_assistance_version_matrix"),
        trigger: ddl.triggers.length > 0,
      };
    },
  );
}

describe("preflight mutation oracle — control · harmless · removed", () => {
  it(
    "control 과 비교해야 preflight 제거가 잡힌다(무해한 변형은 kill 이 아니다)",
    async () => {
      const original = forwardMigrationSql();
      const removedSql = original.replace(/DO \$\$[\s\S]*?END \$\$;/, "");
      const harmlessSql = original.replace(
        "-- ------------------------------------------------------------- 1) preflight",
        "-- ------------------------------------------------------------- 1) preflight (무해한 주석)",
      );

      // 치환이 조용히 no-op 되면 이 테스트는 아무것도 증명하지 못한다.
      expect(removedSql).not.toBe(original);
      expect(harmlessSql).not.toBe(original);
      // 제거 여부는 **실행 SQL** 로 본다 — 설명 주석에도 같은 문구가 있어 원문으로 보면 잘못 판정한다.
      expect(executableSql(original)).toContain("지원하지 않는 rules_version");
      expect(executableSql(removedSql)).not.toContain("지원하지 않는 rules_version");
      expect(executableSql(removedSql)).not.toContain("DO $$");
      // harmless 는 preflight 를 그대로 갖고 있어야 한다(주석 한 줄만 다르다).
      expect(executableSql(harmlessSql)).toBe(executableSql(original));

      const control = await observeUnknown(original, "orc_ctl");
      const harmless = await observeUnknown(harmlessSql, "orc_harm");
      const removed = await observeUnknown(removedSql, "orc_rem");

      // control: 내 preflight 가 막고, 보정·audit·DDL 이 0 이다.
      expect(control).toEqual({
        forwardApplied: false,
        failure: "custom_preflight",
        unknown: "native/9999.99.9/42.5",
        performed: "native/2026.08.1/42.5",
        unperformed: "native/2026.08.1/42.5",
        auditCount: 0,
        matrixCheck: false,
        trigger: false,
      });

      // harmless: 관측이 control 과 **exact 동일** — mutation kill 로 세지 않는다.
      expect(harmless).toEqual(control);

      // removed: 롤백 때문에 row·audit·DDL 은 같지만 **failure 의 출처가 다르다.**
      expect(removed.failure).not.toBe("custom_preflight");
      expect(removed.failure).toBe("version_matrix");
      expect(removed).not.toEqual(control);

      // 옛 oracle(`observed !== HEALTHY`)이 왜 공허했는지를 **실행 가능한 형태로** 남긴다.
      // unknown fixture 는 unknown 이 없는 HEALTHY 와 어차피 다르므로, 무해한 변형은 물론
      // **변형이 전혀 없는 control 조차** "검출"로 통과했다.
      const oldOracleWouldPass = (o: UnknownObservation): boolean =>
        o.forwardApplied !== HEALTHY.applied ||
        o.performed !== HEALTHY.performed ||
        o.unperformed !== HEALTHY.unperformed;
      expect(oldOracleWouldPass(harmless)).toBe(true);
      expect(oldOracleWouldPass(control)).toBe(true);
    },
    PROBE_TIMEOUT * 3,
  );
});

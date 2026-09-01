import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { ASSISTANCE_PROVENANCE_VERSIONS } from "shared";
import { PrismaService } from "../src/prisma/prisma.service";
import { devUserId } from "../src/auth/dev-user";
import { createTestApp, resetUserData } from "./support/app";
import {
  assertAssistanceSnapshot,
  loadSemanticsFor,
  projectAssistanceSnapshot,
  provenanceForRow,
} from "../src/programs/assistance-migration";

const DEV_USER_ID = devUserId();
const ASSISTED = "e_assisted_pullup";
const EXTERNAL = "e_chest_press_machine";
const UNKNOWN_VERSION = "9999.99.9";

const MIGRATIONS = join(__dirname, "..", "prisma", "migrations");
const APPLIED_SQL = join(MIGRATIONS, "20260827120000_f3_assistance_semantics", "migration.sql");
const FIXUP_SQL = join(MIGRATIONS, "20260827180000_f3_fixup_assistance_lifecycle", "migration.sql");

/** 주석을 걷어낸 실행 SQL. 설명 문구가 단언에 섞이면 "무엇을 실행하는가"를 못 본다. */
function executableSql(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** 실행 문장 단위. `DO $$ … $$` 블록은 조각나지만 여기서 찾는 대상이 아니다. */
function statementContaining(path: string, prefix: string, needle: string): string {
  const statement = executableSql(path)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix) && part.includes(needle));
  if (!statement) {
    throw new Error(`forward migration 에서 문장을 찾지 못했다: ${prefix} … ${needle}`);
  }
  return statement;
}

/**
 * F-3 — 어시스트 migration · matrix · immutability · projector.
 *
 * **pain 을 복호화하지 않는다.** provenance 판정은 performed fact 의 **유무**만 본다.
 *
 * **불변식을 어기는 행은 삽입·UPDATE 자체가 불가능하다.** 그래서 "고치는" runtime updater 는
 * 두지 않고, 거부되는 것 자체가 불변식의 **양성 증거**다.
 */

// ------------------------------------------------- ① 순수 분류 truth table

describe("① provenanceForRow — 수행 여부 × rules_version", () => {
  const cases: Array<[string, boolean, string]> = [
    ["2026.08.1", false, "remediated"],
    ["2026.08.1", true, "legacy_performed"],
    ["2026.08.2", false, "native"],
    ["2026.08.2", true, "native"],
    ["2026.09.0", false, "native"],
    ["2026.09.0", true, "native"],
    ["2026.09.1", false, "native"],
    ["2026.09.1", true, "native"],
  ];

  it.each(cases)("%s / performed=%s → %s", (rulesVersion, hasPerformedFact, expected) => {
    expect(provenanceForRow({ rulesVersion, hasPerformedFact })).toBe(expected);
  });

  it("legacy 만 수행 여부로 갈린다 — capable 버전은 항상 native", () => {
    for (const v of ["2026.08.2", "2026.09.0", "2026.09.1"]) {
      expect(provenanceForRow({ rulesVersion: v, hasPerformedFact: true })).toBe(
        provenanceForRow({ rulesVersion: v, hasPerformedFact: false }),
      );
    }
    expect(provenanceForRow({ rulesVersion: "2026.08.1", hasPerformedFact: true })).not.toBe(
      provenanceForRow({ rulesVersion: "2026.08.1", hasPerformedFact: false }),
    );
  });

  it("unknown 버전은 fail closed — 조용히 분류하지 않고 throw 한다", () => {
    for (const hasPerformedFact of [true, false]) {
      expect(() => provenanceForRow({ rulesVersion: UNKNOWN_VERSION, hasPerformedFact })).toThrow(
        RangeError,
      );
    }
  });
});

// ------------------------------------------------------------- ② freeze

describe("② migration 파일 freeze · forward-fix 순서", () => {
  const applied = readFileSync(APPLIED_SQL, "utf8");
  const fixup = readFileSync(FIXUP_SQL, "utf8");

  it("적용된 파일의 checksum 이 그대로다 — 적용 후 수정 금지", () => {
    expect(createHash("sha256").update(applied, "utf8").digest("hex")).toBe(
      "4482d8b5e5acd2e83b70abdd0080cf1b3211551eb11d1f956487d1af90d8bb84",
    );
  });

  it("적용된 파일의 순서가 계약대로다: nullable → backfill/audit → CHECK", () => {
    const addColumn = applied.indexOf('ADD COLUMN "assistance_provenance"');
    const backfill = applied.indexOf('SET "assistance_provenance" = CASE');
    const audit = applied.indexOf('INSERT INTO "assistance_audits"');
    const check = applied.indexOf("ck_planned_assistance_snapshot");
    expect(addColumn).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(addColumn);
    expect(audit).toBeGreaterThan(backfill);
    expect(check).toBeGreaterThan(audit);
  });

  it("forward-fix 순서: preflight → correction → matrix CHECK → trigger", () => {
    const executable = executableSql(FIXUP_SQL);
    const preflight = executable.indexOf("RAISE EXCEPTION");
    const correction = executable.indexOf("'ASSISTANCE_CALIBRATION_NEEDED'");
    const matrix = executable.indexOf("ck_planned_assistance_version_matrix");
    const trigger = executable.indexOf("CREATE TRIGGER");
    expect(preflight).toBeGreaterThan(-1);
    expect(executable.slice(0, preflight)).toContain("DO $$");
    expect(correction).toBeGreaterThan(preflight);
    expect(matrix).toBeGreaterThan(correction);
    expect(trigger).toBeGreaterThan(matrix);
  });

  it("forward-fix 는 additive 다 — 컬럼·테이블을 지우지 않는다", () => {
    expect(executableSql(FIXUP_SQL)).not.toMatch(/DROP\s+(COLUMN|TABLE|TYPE)/i);
    expect(fixup).toContain("destructive down migration 을 만들지 않는다");
  });

  it("두 migration 모두 통증을 읽지 않는다", () => {
    for (const path of [APPLIED_SQL, FIXUP_SQL]) {
      expect(executableSql(path)).not.toContain("pain_score");
    }
  });

  it("SQL matrix 가 shared ASSISTANCE_PROVENANCE_VERSIONS 와 같은 집합이다", () => {
    // 한쪽만 넓으면 그쪽이 우회 경로가 된다. 목록을 눈으로 맞추지 않고 대조한다.
    const clause = statementContaining(
      FIXUP_SQL,
      'ALTER TABLE "planned_sets"',
      "ck_planned_assistance_version_matrix",
    );
    for (const [provenance, versions] of Object.entries(ASSISTANCE_PROVENANCE_VERSIONS)) {
      const branch = clause.slice(clause.indexOf(`"assistance_provenance" = '${provenance}'`));
      const listed = [...branch.matchAll(/'(\d{4}\.\d{2}\.\d)'/g)].map((m) => m[1]);
      expect(listed.slice(0, versions.length).sort()).toEqual([...versions].sort());
    }
  });

  it("trigger 는 rules_version 을 잠그지 않는다 — F6-1·activation 이 갱신한다", () => {
    const executable = executableSql(FIXUP_SQL);
    const fn = executable.slice(
      executable.indexOf("RETURNS trigger"),
      executable.indexOf("CREATE TRIGGER"),
    );
    expect(fn).toContain('"load_semantics"');
    expect(fn).toContain('"assistance_step_kg"');
    expect(fn).toContain('"assistance_provenance"');
    expect(fn).not.toContain('"rules_version"');
  });
});

describe("F-3 post-migration 상태", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, DEV_USER_ID);
  });

  /** 저장 규칙(matrix)을 만족하는 planned 행을 만든다. */
  async function seedPlanned(opts: {
    exerciseId: string;
    rulesVersion: string;
    provenance?: "native" | "remediated" | "legacy_performed";
    performed?: boolean;
    recommendedWeight?: string | null;
    reasonCode?: string;
  }): Promise<{ plannedSetId: string; performedSetId?: string }> {
    const program = await prisma.program.create({
      data: {
        userId: DEV_USER_ID,
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
        status: opts.performed ? "completed" : "scheduled",
      },
    });
    const assisted = loadSemanticsFor(opts.exerciseId) === "assistance";
    const planned = await prisma.plannedSet.create({
      data: {
        sessionId: session.id,
        exerciseId: opts.exerciseId,
        orderIndex: 0,
        setNo: 1,
        targetRepsLow: 8,
        targetRepsHigh: 12,
        targetRir: 2,
        restSec: 90,
        recommendedWeight: opts.recommendedWeight === undefined ? "20" : opts.recommendedWeight,
        recommendedReps: 8,
        loadSemantics: loadSemanticsFor(opts.exerciseId),
        // matrix 가 요구하는 짝. 미분류 어시스트 행은 삽입 자체가 불가능하다.
        ...(assisted
          ? {
              assistanceStepKg: "2.50",
              assistanceProvenance: opts.provenance ?? "native",
            }
          : {}),
        reasonCode: opts.reasonCode ?? "WEIGHT_UP_REP_TARGET_MET",
        confidence: "0.85",
        rulesVersion: opts.rulesVersion,
      },
    });
    if (!opts.performed) return { plannedSetId: planned.id };
    const performed = await prisma.performedSet.create({
      data: {
        plannedSetId: planned.id,
        actualWeight: "20",
        actualReps: 12,
        actualRir: 2,
        completed: true,
        clientId: crypto.randomUUID(),
        performedAt: new Date("2026-08-03T10:00:00Z"),
      },
    });
    return { plannedSetId: planned.id, performedSetId: performed.id };
  }

  describe("카탈로그 post-state", () => {
    it("모든 종목이 canonical load_semantics 를 갖는다 — NULL 0", async () => {
      const total = await prisma.exercise.count();
      const external = await prisma.exercise.count({ where: { loadSemantics: "external_load" } });
      const assistance = await prisma.exercise.count({ where: { loadSemantics: "assistance" } });
      expect(external + assistance).toBe(total);
    });

    it("어시스트 머신만 assistance 다", async () => {
      const rows = await prisma.exercise.findMany({
        where: { loadSemantics: "assistance" },
        select: { id: true },
      });
      expect(rows.map((r) => r.id).sort()).toEqual([ASSISTED]);
    });
  });

  describe("③ nullable 짝 CHECK — valid / invalid", () => {
    it("valid: assisted + provenance + step", async () => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion: "2026.08.2",
      });
      const row = await prisma.plannedSet.findUniqueOrThrow({ where: { id: plannedSetId } });
      expect(row.assistanceProvenance).toBe("native");
      expect(row.assistanceStepKg).not.toBeNull();
    });

    it("valid: non-assisted + 둘 다 null", async () => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: EXTERNAL,
        rulesVersion: "2026.08.1",
      });
      const row = await prisma.plannedSet.findUniqueOrThrow({ where: { id: plannedSetId } });
      expect(row.assistanceProvenance).toBeNull();
      expect(row.assistanceStepKg).toBeNull();
    });

    it("invalid: 어시스트 종목인데 provenance 가 없으면 삽입이 거부된다", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO planned_sets (id, session_id, exercise_id, order_index, set_no, rest_sec,
             reason_code, confidence, rules_version, load_semantics, updated_at)
           VALUES (gen_random_uuid(), gen_random_uuid(), $1, 0, 1, 90, 'BASELINE', 0,
             '2026.08.2', 'assistance', now())`,
          ASSISTED,
        ),
      ).rejects.toThrow();
    });
  });

  describe("④ exact provenance × rules_version matrix", () => {
    const invalid: Array<[string, string]> = [
      ["native", "2026.08.1"],
      ["remediated", "2026.09.0"],
      ["legacy_performed", "2026.08.2"],
      ["legacy_performed", "2026.09.1"],
      ["native", UNKNOWN_VERSION],
    ];

    it.each(invalid)("DB: %s + %s 는 거부된다", async (provenance, rulesVersion) => {
      await expect(
        seedPlanned({
          exerciseId: ASSISTED,
          rulesVersion,
          provenance: provenance as "native",
        }),
      ).rejects.toThrow();
    });

    const valid: Array<[string, string]> = [
      ["native", "2026.08.2"],
      ["native", "2026.09.0"],
      ["native", "2026.09.1"],
      ["remediated", "2026.08.2"],
      ["legacy_performed", "2026.08.1"],
    ];

    it.each(valid)("DB: %s + %s 는 허용된다", async (provenance, rulesVersion) => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion,
        provenance: provenance as "native",
      });
      const row = await prisma.plannedSet.findUniqueOrThrow({ where: { id: plannedSetId } });
      expect(row.assistanceProvenance).toBe(provenance);
    });

    it("service guard 가 DB 와 같은 허용/거부 판정을 낸다", () => {
      for (const [provenance, rulesVersion] of valid) {
        expect(() =>
          assertAssistanceSnapshot({
            loadSemantics: "assistance",
            assistanceStepKg: "2.50",
            assistanceProvenance: provenance as "native",
            rulesVersion,
          }),
        ).not.toThrow();
      }
      for (const [provenance, rulesVersion] of invalid) {
        expect(() =>
          assertAssistanceSnapshot({
            loadSemantics: "assistance",
            assistanceStepKg: "2.50",
            assistanceProvenance: provenance as "native",
            rulesVersion,
          }),
        ).toThrow();
      }
    });

    it("service guard 가 semantics ⇔ provenance ⇔ step 짝도 본다", () => {
      expect(() =>
        assertAssistanceSnapshot({
          loadSemantics: "external_load",
          assistanceStepKg: null,
          assistanceProvenance: null,
          rulesVersion: "2026.08.1",
        }),
      ).not.toThrow();
      expect(() =>
        assertAssistanceSnapshot({
          loadSemantics: "assistance",
          assistanceStepKg: "2.50",
          assistanceProvenance: null,
          rulesVersion: "2026.08.2",
        }),
      ).toThrow(/provenance/);
      expect(() =>
        assertAssistanceSnapshot({
          loadSemantics: "external_load",
          assistanceStepKg: null,
          assistanceProvenance: "native",
          rulesVersion: "2026.08.2",
        }),
      ).toThrow(/provenance/);
      expect(() =>
        assertAssistanceSnapshot({
          loadSemantics: "assistance",
          assistanceStepKg: null,
          assistanceProvenance: "native",
          rulesVersion: "2026.08.2",
        }),
      ).toThrow(/step/);
    });

    it("rules_version 변경은 matrix 를 만족할 때만 통과한다", async () => {
      const ok = await seedPlanned({ exerciseId: ASSISTED, rulesVersion: "2026.08.2" });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE planned_sets SET rules_version = '2026.09.0' WHERE id = $1::uuid`,
          ok.plannedSetId,
        ),
      ).resolves.toBe(1);

      const bad = await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion: "2026.08.2",
        provenance: "remediated",
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE planned_sets SET rules_version = '2026.09.0' WHERE id = $1::uuid`,
          bad.plannedSetId,
        ),
      ).rejects.toThrow();
    });

    it("non-assisted 행의 rules_version 은 자유롭게 올라간다(activation pointer flip 경로)", async () => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: EXTERNAL,
        rulesVersion: "2026.08.1",
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE planned_sets SET rules_version = '2026.09.0' WHERE id = $1::uuid`,
          plannedSetId,
        ),
      ).resolves.toBe(1);
    });
  });

  describe("⑤ snapshot immutability trigger — valid→valid 도 거부", () => {
    const axes: Array<[string, string]> = [
      ["load_semantics", `load_semantics = 'external_load'`],
      ["assistance_step_kg", `assistance_step_kg = 5.00`],
      ["assistance_provenance", `assistance_provenance = 'remediated'`],
    ];

    it.each(axes)("%s 변경이 거부된다", async (_axis, assignment) => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion: "2026.08.2",
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE planned_sets SET ${assignment} WHERE id = $1::uuid`,
          plannedSetId,
        ),
      ).rejects.toThrow();
    });

    it("snapshot 밖 필드(처방)는 계속 갱신된다 — 전면 잠금이 아니다", async () => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion: "2026.08.2",
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE planned_sets SET recommended_reps = 10 WHERE id = $1::uuid`,
          plannedSetId,
        ),
      ).resolves.toBe(1);
    });

    it("non-assisted 행의 NULL snapshot 도 잠긴다", async () => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: EXTERNAL,
        rulesVersion: "2026.08.1",
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE planned_sets SET load_semantics = 'assistance' WHERE id = $1::uuid`,
          plannedSetId,
        ),
      ).rejects.toThrow();
    });
  });

  describe("⑥ remediated 처방 교정 — 실제 forward SQL 을 적용한다", () => {
    /** forward migration 파일에서 교정 문장을 그대로 꺼낸다(테스트용 재작성 금지). */
    function correctionStatement(): string {
      return statementContaining(
        FIXUP_SQL,
        'UPDATE "planned_sets"',
        "'ASSISTANCE_CALIBRATION_NEEDED'",
      );
    }

    it("stale weight/일반 reason 이 무게 미정 + calibration 으로 바뀐다", async () => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion: "2026.08.2",
        provenance: "remediated",
        recommendedWeight: "42.50",
        reasonCode: "WEIGHT_UP_REP_TARGET_MET",
      });

      await prisma.$executeRawUnsafe(correctionStatement());

      const row = await prisma.plannedSet.findUniqueOrThrow({ where: { id: plannedSetId } });
      expect(row.recommendedWeight).toBeNull();
      expect(row.reasonCode).toBe("ASSISTANCE_CALIBRATION_NEEDED");
      expect(Number(row.confidence)).toBe(0);
      // 무게 미정은 0kg sentinel 이 아니다.
      expect(row.recommendedWeight).not.toBe(0);
    });

    it("legacy_performed 행과 performed fact 는 교정이 건드리지 않는다", async () => {
      const { plannedSetId, performedSetId } = await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion: "2026.08.1",
        provenance: "legacy_performed",
        performed: true,
      });
      const plannedBefore = await prisma.plannedSet.findUniqueOrThrow({
        where: { id: plannedSetId },
      });
      const performedBefore = await prisma.performedSet.findUniqueOrThrow({
        where: { id: performedSetId! },
      });

      await prisma.$executeRawUnsafe(correctionStatement());

      expect(
        JSON.stringify(await prisma.plannedSet.findUniqueOrThrow({ where: { id: plannedSetId } })),
      ).toBe(JSON.stringify(plannedBefore));
      expect(
        JSON.stringify(
          await prisma.performedSet.findUniqueOrThrow({ where: { id: performedSetId! } }),
        ),
      ).toBe(JSON.stringify(performedBefore));
    });

    it("non-assisted 행도 교정 대상이 아니다", async () => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: EXTERNAL,
        rulesVersion: "2026.08.1",
      });
      const before = await prisma.plannedSet.findUniqueOrThrow({ where: { id: plannedSetId } });

      await prisma.$executeRawUnsafe(correctionStatement());

      expect(
        JSON.stringify(await prisma.plannedSet.findUniqueOrThrow({ where: { id: plannedSetId } })),
      ).toBe(JSON.stringify(before));
    });
  });

  describe("⑦ audit 멱등 — SQL ON CONFLICT 가 소유한다", () => {
    /** forward migration 의 audit INSERT 를 그대로 꺼낸다. */
    function auditInsert(): string {
      return statementContaining(FIXUP_SQL, 'INSERT INTO "assistance_audits"', "ON CONFLICT");
    }

    it("두 번 실행해도 중복 0 · planned 행 JSON exact 동일", async () => {
      await seedPlanned({ exerciseId: ASSISTED, rulesVersion: "2026.08.2" });
      await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion: "2026.08.1",
        provenance: "legacy_performed",
        performed: true,
      });

      const firstInserted = await prisma.$executeRawUnsafe(auditInsert());
      const auditsAfterFirst = await prisma.assistanceAudit.count();
      const rowsAfterFirst = await prisma.plannedSet.findMany({ orderBy: { id: "asc" } });

      const secondInserted = await prisma.$executeRawUnsafe(auditInsert());
      const rowsAfterSecond = await prisma.plannedSet.findMany({ orderBy: { id: "asc" } });

      expect(firstInserted).toBeGreaterThan(0);
      expect(secondInserted).toBe(0);
      expect(await prisma.assistanceAudit.count()).toBe(auditsAfterFirst);
      expect(JSON.stringify(rowsAfterSecond)).toBe(JSON.stringify(rowsAfterFirst));
    });

    it("audit unique key 는 (planned_set_id, action) 이다", async () => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion: "2026.08.2",
      });
      await prisma.$executeRawUnsafe(auditInsert());
      await expect(
        prisma.assistanceAudit.create({
          data: { plannedSetId, action: "native", metadata: {} },
        }),
      ).rejects.toThrow();
    });

    it("audit 은 ciphertext·평문 통증을 담지 않는다", async () => {
      await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion: "2026.08.1",
        provenance: "legacy_performed",
        performed: true,
      });
      await prisma.$executeRawUnsafe(auditInsert());
      const dump = JSON.stringify(await prisma.assistanceAudit.findMany());
      expect(dump).not.toContain("v1:");
      expect(dump).not.toMatch(/pain/i);
    });
  });

  describe("⑧ snapshot projector", () => {
    it("어시스트 행은 저장된 snapshot 으로 표시값을 만든다", async () => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: ASSISTED,
        rulesVersion: "2026.08.2",
      });
      const row = await prisma.plannedSet.findUniqueOrThrow({ where: { id: plannedSetId } });
      const projected = projectAssistanceSnapshot(row);
      expect(projected.load_kind).toBe("assistance");
      expect(projected.assistance_provenance).toBe("native");
      expect(projected.assistance_kg).toBeGreaterThan(0);
    });

    it("non-assisted 행은 assistance 축이 없다", async () => {
      const { plannedSetId } = await seedPlanned({
        exerciseId: EXTERNAL,
        rulesVersion: "2026.08.1",
      });
      const row = await prisma.plannedSet.findUniqueOrThrow({ where: { id: plannedSetId } });
      const projected = projectAssistanceSnapshot(row);
      expect(projected.load_kind).toBe("external");
      expect(projected.assistance_provenance).toBeNull();
    });

    it("카탈로그를 다시 읽지 않는다 — 카탈로그에 없는 id 여도 snapshot 대로 해석한다", () => {
      const projected = projectAssistanceSnapshot({
        assistanceProvenance: "native",
        assistanceStepKg: "2.50" as unknown as never,
        recommendedWeight: "20" as unknown as never,
      } as never);
      expect(projected.load_kind).toBe("assistance");
      expect(projected.assistance_step_kg).toBe(2.5);
    });
  });
});

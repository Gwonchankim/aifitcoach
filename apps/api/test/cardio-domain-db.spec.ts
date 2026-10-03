import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "./support/database-url";
import { parseSeedFile, parseSeedRows, seedExercises } from "../prisma/seed-exercises";
import { isResistanceExercise } from "../src/exercises/exercise-domain";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });
const uid = randomUUID();
let sessionId: string;
function steady(): Prisma.PlannedSetUncheckedCreateInput {
  return {
    id: randomUUID(),
    sessionId,
    exerciseId: "e_stationary_bike",
    orderIndex: 0,
    setNo: 1,
    prescriptionKind: "steady_cardio",
    durationSec: 600,
    rpeScaleId: "relative_effort_0_10_v1",
    targetRpeLow: 5,
    targetRpeHigh: 6,
    longSessionFlag: false,
    progressionAxis: "duration_sec",
    sourceDay: "MON",
    sourceOrdinal: 1,
    intensitySeconds: { moderate: 600, high: 0, recovery: 0 },
    rulesVersion: "2026.09.1",
    restSec: null,
    reasonCode: null,
    confidence: null,
    loadSemantics: null,
  };
}
function interval(): Prisma.PlannedSetUncheckedCreateInput {
  return {
    ...steady(),
    prescriptionKind: "interval_cardio",
    durationSec: 720,
    targetRpeLow: 7,
    targetRpeHigh: 8,
    workSec: 60,
    recoverySec: 60,
    rounds: 6,
    recoveryRpeLow: 2,
    recoveryRpeHigh: 3,
    finalRecoveryIncluded: true,
    progressionAxis: "rounds",
    intensitySeconds: { moderate: 0, high: 360, recovery: 360 },
  };
}
async function insert(data: Prisma.PlannedSetUncheckedCreateInput) {
  return prisma.plannedSet.create({ data });
}
describe("S2 cardio DB conditional CHECK matrix", () => {
  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: uid,
        sex: "other",
        birthYear: 1990,
        heightCm: 170,
        weightKg: 70,
        goal: "diet",
        experienceLevel: "beginner",
        constraints: {},
      },
    });
    const program = await prisma.program.create({
      data: {
        userId: uid,
        goal: "diet",
        daysPerWeek: 2,
        minutesPerDay: 60,
        splitType: "full_body",
        rulesVersion: "2026.09.1",
      },
    });
    sessionId = (
      await prisma.workoutSession.create({
        data: {
          programId: program.id,
          scheduledDate: new Date("2026-09-28T00:00:00Z"),
          focus: "full_body",
          status: "scheduled",
        },
      })
    ).id;
  });
  afterEach(async () => {
    await prisma.plannedSet.deleteMany({ where: { sessionId } });
  });
  afterAll(async () => {
    await prisma.workoutSession.deleteMany({ where: { program: { userId: uid } } });
    await prisma.program.deleteMany({ where: { userId: uid } });
    await prisma.user.delete({ where: { id: uid } });
    await prisma.$disconnect();
  });
  it.each(["steady", "interval"])(
    "valid %s persists one block and exact scalar/intensity snapshot",
    async (kind) => {
      const data = kind === "steady" ? steady() : interval();
      const row = await insert(data);
      for (const [key, value] of Object.entries(data))
        expect(row[key as keyof typeof row]).toEqual(value);
      expect(await prisma.plannedSet.count({ where: { sessionId } })).toBe(1);
    },
  );
  it.each([
    "durationSec",
    "rpeScaleId",
    "targetRpeLow",
    "targetRpeHigh",
    "longSessionFlag",
    "progressionAxis",
    "sourceDay",
    "sourceOrdinal",
    "intensitySeconds",
  ])("rejects mandatory steady NULL %s", async (key) => {
    await expect(
      insert({ ...steady(), [key]: key === "intensitySeconds" ? Prisma.DbNull : null }),
    ).rejects.toThrow();
  });
  it.each([
    "workSec",
    "recoverySec",
    "rounds",
    "recoveryRpeLow",
    "recoveryRpeHigh",
    "finalRecoveryIncluded",
  ])("rejects mandatory interval NULL %s", async (key) => {
    await expect(insert({ ...interval(), [key]: null })).rejects.toThrow();
  });
  it.each([
    ["durationSec", 0],
    ["durationSec", -1],
    ["targetRpeLow", -1],
    ["targetRpeHigh", 11],
    ["targetRpeLow", 7],
    ["rpeScaleId", "borg_6_20"],
    ["workSec", 60],
    ["rounds", 1],
    ["progressionAxis", "rounds"],
    ["sourceDay", "UNKNOWN"],
    ["sourceOrdinal", 0],
    ["restSec", 0],
    ["reasonCode", "BASELINE"],
    ["confidence", 0],
    ["loadSemantics", "external_load"],
    ["targetTimeLowSec", 600],
    ["targetRepsLow", 1],
    ["targetRir", 0],
    ["recommendedWeight", 0],
    ["intensitySeconds", { moderate: 600, high: 0 }],
    ["intensitySeconds", { moderate: 600, high: 1, recovery: 0 }],
  ])("rejects invalid steady %s=%j", async (key, value) => {
    await expect(insert({ ...steady(), [key as string]: value })).rejects.toThrow();
  });
  it.each([
    ["durationSec", 660],
    ["rounds", 13],
    ["rounds", 0],
    ["workSec", 2147483647],
    ["recoverySec", 2147483647],
    ["finalRecoveryIncluded", false],
    ["longSessionFlag", true],
    ["progressionAxis", "duration_sec"],
    ["recoveryRpeLow", 4],
    ["recoveryRpeHigh", 11],
  ])("rejects invalid interval %s=%j", async (key, value) => {
    await expect(insert({ ...interval(), [key as string]: value })).rejects.toThrow();
  });
  it.each([null, "resistance"] as const)(
    "legacy/resistance %s cannot smuggle cardio or drop existing mandatory resistance data",
    async (prescriptionKind) => {
      const row: Prisma.PlannedSetUncheckedCreateInput = {
        id: randomUUID(),
        sessionId,
        exerciseId: "e_bench_press",
        orderIndex: 0,
        setNo: 1,
        prescriptionKind,
        rulesVersion: "2026.08.1",
        restSec: 90,
        reasonCode: "BASELINE",
        confidence: 0.5,
        loadSemantics: "external_load",
      };
      for (const key of ["restSec", "reasonCode", "confidence", "loadSemantics"])
        await expect(insert({ ...row, [key]: null })).rejects.toThrow();
      await expect(insert({ ...row, durationSec: 600 })).rejects.toThrow();
      await expect(insert(row)).resolves.toMatchObject({ prescriptionKind });
    },
  );
  it("exact seed is idempotent and cardio is never a resistance candidate", async () => {
    const before = await prisma.exercise.findMany({ orderBy: { id: "asc" } });
    expect(await seedExercises(prisma)).toBe(111);
    expect(await prisma.exercise.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    const all = parseSeedFile();
    expect(all.filter((e) => e.modality === "resistance")).toHaveLength(110);
    const bike = all.find((e) => e.id === "e_stationary_bike")!;
    expect(isResistanceExercise(bike)).toBe(false);
    const raw = JSON.parse(
      readFileSync(resolve(__dirname, "../../../docs/specs/exercises_seed.json"), "utf8"),
    ).exercises;
    for (const key of [
      "cardio_movement_regions",
      "prescription_kinds_supported",
      "blocked_reported_pain_areas",
      "equipment",
      "load_semantics",
    ])
      expect(() =>
        parseSeedRows(
          raw.map((e: Record<string, unknown>) =>
            e.id === bike.id ? { ...e, [key]: undefined } : e,
          ),
        ),
      ).toThrow();
  });
});

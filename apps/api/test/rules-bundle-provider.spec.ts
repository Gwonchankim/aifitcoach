import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ROUTINE_RULES_VERSION, RULES_BUNDLE_V2_SPLIT } from "shared";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProgramRulesBundleProvider } from "../src/programs/program-rules-bundle.provider";
import { ProgramsService } from "../src/programs/programs.service";
import { createTestApp, resetUserData } from "./support/app";

const dto = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;

describe("program rules provider isolation", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await resetUserData(prisma, devUserId());
  });

  it("default_provider_equals_active_pointer", () => {
    const old = process.env.AFC_PROGRAM_RULES_VERSION;
    process.env.AFC_PROGRAM_RULES_VERSION = RULES_BUNDLE_V2_SPLIT;
    try {
      expect(ROUTINE_RULES_VERSION).toBe("2026.08.1");
      expect(new ProgramRulesBundleProvider().current()).toBe(ROUTINE_RULES_VERSION);
      expect(app.get(ProgramRulesBundleProvider).current()).toBe(ROUTINE_RULES_VERSION);
    } finally {
      if (old === undefined) delete process.env.AFC_PROGRAM_RULES_VERSION;
      else process.env.AFC_PROGRAM_RULES_VERSION = old;
    }
  });

  it("only_testing_module_override_selects_reserved_bundle", async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ProgramRulesBundleProvider)
      .useValue({ current: () => RULES_BUNDLE_V2_SPLIT })
      .compile();
    const isolated = configureApp(module.createNestApplication());
    await isolated.init();
    try {
      const result = await isolated.get(ProgramsService).generate(devUserId(), dto);
      expect(result.rules_version).toBe(RULES_BUNDLE_V2_SPLIT);
      await isolated.get(ProgramsService).current(devUserId());
      const rows = await prisma.plannedSet.findMany({
        where: { session: { programId: result.program_id } },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect([...new Set(rows.map((row) => row.rulesVersion))]).toEqual([RULES_BUNDLE_V2_SPLIT]);
      expect(app.get(ProgramRulesBundleProvider).current()).toBe("2026.08.1");
      expect((await app.get(ProgramsService).generate(devUserId(), dto)).rules_version).toBe(
        "2026.08.1",
      );
    } finally {
      await isolated.close();
    }
  });

  it("public_inputs_cannot_select_rules_bundle", async () => {
    const server = app.getHttpServer();
    const body = await request(server)
      .post("/v1/programs/generate")
      .send({ ...dto, rules_version: RULES_BUNDLE_V2_SPLIT });
    expect(body.status).toBe(400);
    const publicResult = await request(server)
      .post(`/v1/programs/generate?rules_version=${RULES_BUNDLE_V2_SPLIT}`)
      .set("X-Rules-Version", RULES_BUNDLE_V2_SPLIT)
      .send(dto)
      .expect(201);
    expect(publicResult.body.rules_version).toBe("2026.08.1");
    for (const goal of ["general_fitness", "endurance"]) {
      await request(server)
        .post("/v1/programs/generate")
        .send({ ...dto, goal })
        .expect(400);
    }
    expect(await prisma.program.count({ where: { userId: devUserId() } })).toBe(1);
  });
});

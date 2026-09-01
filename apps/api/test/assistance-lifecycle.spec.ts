/**
 * F-3 fixup — AssistanceAudit lifecycle (독립 review P1-2).
 *
 * `assistance_audits.planned_set_id` 는 `ON DELETE RESTRICT` 다. 그래서 planned row 를 지우는
 * **모든 production 경로**가 audit 를 같은 트랜잭션에서 먼저 지워야 한다. 하나라도 빠지면
 * 정상 편집이 500 이 되고, 계정 영구 삭제(PIPA 삭제권)가 실패한다.
 *
 * audit 는 사용자의 처방 row 에 붙는 개인정보라 보존 중에는 `/me/export` 에 포함한다
 * (`AccessAudit` 선례와 같은 취급).
 *
 * **통증·암호문·처방 원문을 audit 에 넣지 않는다.**
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";

const USER_ID = devUserId();
const ASSISTED = "e_assisted_pullup";
const PROGRAM = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;

describe("AssistanceAudit lifecycle", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessionId: string;
  let assistedSetIds: string[];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
    await request(app.getHttpServer()).post("/v1/programs/generate").send(PROGRAM).expect(201);
    // 세션은 현재 창을 조회할 때 만들어진다(ensureCurrentWindow).
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
    const session = await prisma.workoutSession.findFirstOrThrow({
      where: { program: { userId: USER_ID } },
      orderBy: { scheduledDate: "asc" },
    });
    sessionId = session.id;

    const existing = await prisma.plannedSet.findMany({
      where: { sessionId, exerciseId: ASSISTED },
      select: { id: true },
    });
    if (existing.length === 0) {
      await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises`)
        .send({ exercise_id: ASSISTED })
        .expect(200);
    }
    const rows = await prisma.plannedSet.findMany({
      where: { sessionId, exerciseId: ASSISTED },
      select: { id: true },
    });
    assistedSetIds = rows.map((row) => row.id);
    expect(assistedSetIds.length).toBeGreaterThan(0);

    // migration 이 만든 audit 를 재현한다 — 그 뒤의 편집이 이 행을 만나야 한다.
    await prisma.assistanceAudit.createMany({
      data: assistedSetIds.map((id) => ({ plannedSetId: id, action: "native", metadata: {} })),
    });
  });

  async function auditCount(): Promise<number> {
    return prisma.assistanceAudit.count({ where: { plannedSetId: { in: assistedSetIds } } });
  }

  describe("planned row 를 지우는 production 경로", () => {
    it("세션 운동 삭제가 audit 를 먼저 지우고 성공한다", async () => {
      expect(await auditCount()).toBeGreaterThan(0);

      await request(app.getHttpServer())
        .delete(`/v1/sessions/${sessionId}/exercises/${ASSISTED}`)
        .expect(200);

      expect(await prisma.plannedSet.count({ where: { id: { in: assistedSetIds } } })).toBe(0);
      expect(await auditCount()).toBe(0);
    });

    it("세션 운동 교체가 audit 를 먼저 지우고 성공한다", async () => {
      const replacement = await prisma.exercise.findFirstOrThrow({
        where: {
          id: { notIn: [ASSISTED] },
          NOT: { plannedSets: { some: { sessionId } } },
        },
        orderBy: { id: "asc" },
      });

      await request(app.getHttpServer())
        .post(`/v1/sessions/${sessionId}/exercises/${ASSISTED}/swap`)
        .send({ to_exercise_id: replacement.id })
        .expect(200);

      expect(await prisma.plannedSet.count({ where: { id: { in: assistedSetIds } } })).toBe(0);
      expect(await auditCount()).toBe(0);
    });

    it("sync 루틴 삭제가 audit 를 먼저 지우고 성공한다", async () => {
      const remaining = await prisma.plannedSet.findMany({
        where: { sessionId, exerciseId: { not: ASSISTED } },
        select: { exerciseId: true },
      });
      const keep = [...new Set(remaining.map((row) => row.exerciseId))];
      expect(keep.length).toBeGreaterThan(0);

      const mutation = {
        client_id: randomUUID(),
        entity: "session_routine",
        entity_id: sessionId,
        op: "upsert",
        updated_at: "2026-08-15T08:00:00.000Z",
        payload: { exercise_ids: keep },
      };

      await request(app.getHttpServer())
        .post("/v1/sync")
        .send({ mutations: [mutation] })
        .expect(200)
        .expect(({ body }) => expect(body.applied).toContain(mutation.client_id));

      expect(await prisma.plannedSet.count({ where: { id: { in: assistedSetIds } } })).toBe(0);
      expect(await auditCount()).toBe(0);
    });
  });

  describe("열람·이동권(GET /me/export)", () => {
    it("보존 중인 audit 가 export 에 포함된다", async () => {
      const response = await request(app.getHttpServer()).get("/v1/me/export").expect(200);
      const audits = response.body.data.assistance_audits as { planned_set_id?: string }[];
      expect(Array.isArray(audits)).toBe(true);
      expect(audits.length).toBe(assistedSetIds.length);
    });

    it("삭제된 planned row 의 audit 는 export 에 남지 않는다", async () => {
      await request(app.getHttpServer())
        .delete(`/v1/sessions/${sessionId}/exercises/${ASSISTED}`)
        .expect(200);

      const response = await request(app.getHttpServer()).get("/v1/me/export").expect(200);
      expect(response.body.data.assistance_audits).toEqual([]);
    });

    it("export 의 audit 에 통증·암호문이 없다", async () => {
      const response = await request(app.getHttpServer()).get("/v1/me/export").expect(200);
      const dump = JSON.stringify(response.body.data.assistance_audits);
      expect(dump).not.toContain("v1:");
      expect(dump).not.toMatch(/pain/i);
    });
  });
});

describe("정리 순서 정적 가드", () => {
  /**
   * globalTeardown 은 실패를 warning 으로 삼킨다 — 순서가 틀려도 root gate 가 green 이다.
   * 그래서 순서를 **소스에서** 잠근다. 실행 단언으로는 이 결함이 드러나지 않는다.
   */
  it("global teardown 이 planned_sets 보다 audit 를 먼저 지운다", () => {
    const source = readFileSync(join(__dirname, "global-teardown.ts"), "utf8");
    const audit = source.indexOf("assistanceAudit.deleteMany");
    const planned = source.indexOf("plannedSet.deleteMany");
    expect(audit).toBeGreaterThan(-1);
    expect(planned).toBeGreaterThan(audit);
  });

  it("purge Job 이 planned_sets 보다 audit 를 먼저 지운다", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "..", "scripts", "purge-deleted-users.mjs"),
      "utf8",
    );
    const audit = source.indexOf("assistanceAudit.deleteMany");
    const planned = source.indexOf("plannedSet.deleteMany");
    expect(audit).toBeGreaterThan(-1);
    expect(planned).toBeGreaterThan(audit);
  });

  it("SECURITY_PIPA 퍼지 순서에 assistance_audits 가 planned_sets 앞에 적혀 있다", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "..", "docs", "SECURITY_PIPA.md"),
      "utf8",
    );
    const audit = source.indexOf("assistance_audits");
    const planned = source.indexOf("planned_sets");
    expect(audit).toBeGreaterThan(-1);
    expect(planned).toBeGreaterThan(audit);
  });
});

import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { expectPrivateEqual } from "./support/private-record-assertions";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { sourceRevision } from "../src/sessions/session-set-snapshot";
import type { MutationDto } from "../src/sync/dto/sync-request.dto";
import { createTestApp, resetUserData } from "./support/app";
import { onSessionDay } from "./support/utc-today";

// Independent request identity oracle. Response parent metadata is deliberately absent.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

describe("BUG-02 server counterpart of a rolled-back local ACK", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const USER = devUserId();
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetUserData(prisma, USER);
    await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({
        goal: "hypertrophy",
        days_per_week: 4,
        minutes_per_day: 60,
        experience_level: "intermediate",
      })
      .expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });

  it("non-null dependency receipt hash, bytes and xmin survive pull and exact retransmission after ACK loss", async () => {
    const source = await prisma.plannedSet.findFirstOrThrow({
      where: {
        session: { program: { userId: USER } },
        exercise: { metric: "reps", equipment: { not: "bodyweight" } },
      },
      orderBy: { id: "asc" },
    });
    await onSessionDay(prisma, source.sessionId, async () => {
      const sync = (mutations: MutationDto[], since?: string) =>
        request(app.getHttpServer())
          .post("/v1/sync")
          .send({ mutations, ...(since ? { since } : {}) })
          .expect(200);
      const parent: MutationDto = {
        client_id: randomUUID(),
        entity: "session_set",
        entity_id: source.sessionId,
        op: "upsert",
        updated_at: "2026-08-14T08:00:00.000Z",
        payload: {
          exercise_id: source.exerciseId,
          correlation_id: randomUUID(),
          source: { source_planned_set_id: source.id, source_revision: sourceRevision(source) },
        },
      };
      expect((await sync([parent])).body.applied).toEqual([parent.client_id]);
      const child: MutationDto = {
        client_id: randomUUID(),
        entity: "performed_set",
        entity_id: parent.payload.correlation_id as string,
        op: "upsert",
        updated_at: "2026-08-14T08:00:01.000Z",
        payload: { actual_weight: 73.25, actual_reps: 11, actual_rir: 2, completed: true },
        append_dependencies: { session_id: source.sessionId, client_ids: [parent.client_id] },
      };
      const sent = structuredClone(child);
      const first = await sync([child]);
      expect(first.body.applied).toEqual([child.client_id]);
      expect(first.body.conflicts).toEqual([]);
      const receipt = await prisma.syncMutation.findUniqueOrThrow({
        where: { id: child.client_id },
      });
      expect(receipt.requestHash).toMatch(/^[a-f0-9]{64}$/);
      const expectedHash = createHash("sha256").update(canonical(child)).digest("hex");
      expect(receipt.requestHash).toBe(expectedHash);
      expect(receipt.dependencyIdentity).not.toBeNull();
      expect(receipt.resultIdentity).toMatchObject({ session_id: source.sessionId });
      const factId = receipt.entityId;
      expect(
        first.body.changes.find((row: { entity_id: string }) => row.entity_id === factId)
          ?.session_id,
      ).toBe(source.sessionId);
      const snapshot = async () => ({
        receipt: await prisma.syncMutation.findUniqueOrThrow({ where: { id: child.client_id } }),
        facts: await prisma.performedSet.findMany({
          where: { plannedSet: { sessionId: source.sessionId } },
        }),
        versions: await prisma.$queryRaw`
          SELECT 'receipt' AS kind, xmin::text, id::text FROM sync_mutations WHERE id = ${child.client_id}::uuid
          UNION ALL SELECT 'fact', xmin::text, id::text FROM performed_sets WHERE planned_set_id = ${factId}::uuid
          UNION ALL SELECT 'planned', xmin::text, id::text FROM planned_sets WHERE session_id = ${source.sessionId}::uuid
          UNION ALL SELECT 'session', xmin::text, id::text FROM workout_sessions WHERE id = ${source.sessionId}::uuid
          ORDER BY kind, id`,
      });
      const before = await snapshot();
      // A local marker/cursor tx rollback retains this original outbox mutation. Server-side
      // replay is measured here; the client rollback itself is sync-record-recovery's A oracle.
      const replay = await sync([sent]);
      expect(replay.body.applied).toEqual([child.client_id]);
      expect(replay.body.conflicts).toEqual([]);
      await sync([], first.body.next_cursor);
      const pull = await sync([]);
      expect(
        pull.body.changes.find((row: { entity_id: string }) => row.entity_id === factId)
          ?.session_id,
      ).toBe(source.sessionId);
      expectPrivateEqual(await snapshot(), before);
      expect(await prisma.performedSet.count({ where: { plannedSetId: factId } })).toBe(1);
      expectPrivateEqual(child, sent);
    });
  });
});

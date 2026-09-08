/** I05/M2 missing conjunctions only. Actual DB execution belongs to main's ordinary owned gate. */
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { INestApplication } from "@nestjs/common";
import type { PlannedSet } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { sourceRevision } from "../src/sessions/session-set-snapshot";
import type { PlannedSetResponse } from "../src/sessions/sessions.service";
import type { MutationDto } from "../src/sync/dto/sync-request.dto";
import { createTestApp, resetUserData } from "./support/app";
import { expectMatchesContract } from "./support/openapi-response";

const USER = devUserId();
const EXERCISE = "e_bench_press";
const OTHER = "e_chest_press_machine";
const T0 = "2026-08-14T08:00:00.000Z";
const T1 = "2026-08-14T08:00:01.000Z";
const T2 = "2026-08-14T08:00:02.000Z";
const T3 = "2026-08-14T08:00:03.000Z";
type Wire = {
  applied: string[];
  conflicts: { client_id: string; reason: string }[];
  planned_set_mappings: {
    correlation_id: string;
    planned_set_id: string;
    planned_set: PlannedSetResponse;
  }[];
};
// Routine's existing updateMany may touch updatedAt even when ordering is unchanged.
// Raw prescription, ID, numbering, correlation and every other stored field must remain exact.
const snapshotRow = ({ updatedAt: _updatedAt, ...row }: PlannedSet) => row;
const copiedRaw = (row: PlannedSet) => {
  const {
    id: _id,
    sessionId: _sessionId,
    exerciseId: _exerciseId,
    clientCorrelationId: _correlation,
    setNo: _setNo,
    ...raw
  } = snapshotRow(row);
  return raw;
};

describe("I05 M2 old routine and lost correlated child response boundaries", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  }, 60_000);
  beforeEach(async () => resetUserData(prisma, USER));
  afterAll(async () => {
    try {
      if (prisma) await resetUserData(prisma, USER);
    } finally {
      await app?.close();
    }
  });
  const syncRequest = (mutations: MutationDto[]) =>
    request(app.getHttpServer()).post("/v1/sync").send({ mutations });
  async function sync(mutations: MutationDto[]): Promise<Wire> {
    const response = await syncRequest(mutations).expect(200);
    expectMatchesContract("post", "/sync", 200, response.body);
    return response.body as Wire;
  }
  const direct = (m: MutationDto) =>
    request(app.getHttpServer())
      .post(`/v1/sessions/${m.entity_id}/sets`)
      .send({ client_id: m.client_id, ...m.payload });
  const rows = (sessionId: string) =>
    prisma.plannedSet.findMany({
      where: { sessionId },
      orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
    });
  const receipt = (id: string) => prisma.syncMutation.findUniqueOrThrow({ where: { id } });
  async function get(sessionId: string) {
    const response = await request(app.getHttpServer())
      .get(`/v1/sessions/${sessionId}`)
      .expect(200);
    expectMatchesContract("get", "/sessions/{sessionId}", 200, response.body);
    return response.body.planned_sets as PlannedSetResponse[];
  }
  function append(sessionId: string, source: PlannedSet | string): MutationDto {
    return {
      client_id: randomUUID(),
      entity: "session_set",
      entity_id: sessionId,
      op: "upsert",
      updated_at: T2,
      payload: {
        exercise_id: EXERCISE,
        correlation_id: randomUUID(),
        source:
          typeof source === "string"
            ? { source_correlation_id: source }
            : { source_planned_set_id: source.id, source_revision: sourceRevision(source) },
      },
    };
  }
  const correlation = (m: MutationDto) => m.payload.correlation_id as string;
  function actual(parent: MutationDto): MutationDto {
    return {
      client_id: randomUUID(),
      entity: "performed_set",
      entity_id: correlation(parent),
      op: "upsert",
      updated_at: T3,
      payload: { actual_weight: 73.25, actual_reps: 11, actual_rir: 4, completed: true },
      append_dependencies: { session_id: parent.entity_id, client_ids: [parent.client_id] },
    };
  }
  async function fixture() {
    const program = await prisma.program.create({
      data: {
        userId: USER,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
        startedAt: utcToday(),
        generationInput: { goal: "hypertrophy", days_per_week: 4, minutes_per_day: 60 },
        template: [
          {
            day: "MON",
            focus: "upper",
            exercises: [
              { exercise_id: EXERCISE, sets: 3 },
              { exercise_id: OTHER, sets: 2 },
            ],
          },
        ],
      },
    });
    const session = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: utcToday(),
        focus: "upper",
        status: "scheduled",
      },
    });
    const correlations = [EXERCISE, OTHER].flatMap((exercise_id) =>
      Array.from({ length: exercise_id === EXERCISE ? 3 : 2 }, (_, index) => ({
        correlation_id: randomUUID(),
        exercise_id,
        set_no: index + 1,
      })),
    );
    const initial: MutationDto = {
      client_id: randomUUID(),
      entity: "session_routine",
      entity_id: session.id,
      op: "upsert",
      updated_at: T0,
      payload: { exercise_ids: [EXERCISE, OTHER], correlations },
    };
    expect((await sync([initial])).applied).toEqual([initial.client_id]);
    const sourceRows = await rows(session.id);
    expect(sourceRows).toHaveLength(5);
    return {
      session,
      initial,
      correlations,
      source: sourceRows.find((row) => row.exerciseId === EXERCISE && row.setNo === 3)!,
    };
  }
  async function state(sessionId: string) {
    return {
      rows: (await rows(sessionId)).map(snapshotRow),
      facts: await prisma.performedSet.findMany({
        where: { plannedSet: { sessionId } },
        orderBy: { id: "asc" },
      }),
      session: await prisma.workoutSession.findUniqueOrThrow({ where: { id: sessionId } }),
      audits: await prisma.assistanceAudit.findMany({
        where: { plannedSet: { sessionId } },
        orderBy: { id: "asc" },
      }),
      ledger: await prisma.syncMutation.findMany({
        where: { userId: USER },
        orderBy: { id: "asc" },
      }),
    };
  }
  it.each(["exercise_ids only", "unchanged group existing correlations"])(
    "old routine captured before append preserves retained group: %s",
    async (mode) => {
      const f = await fixture();
      // Capture BEFORE the append exists. Never send a now-shortened correlation list for its group.
      const old: MutationDto = {
        client_id: randomUUID(),
        entity: "session_routine",
        entity_id: f.session.id,
        op: "upsert",
        updated_at: T1,
        payload: {
          exercise_ids: [EXERCISE, OTHER],
          ...(mode === "exercise_ids only"
            ? {}
            : { correlations: f.correlations.filter((row) => row.exercise_id === OTHER) }),
        },
      };
      const bytes = JSON.stringify(old);
      const a = append(f.session.id, f.source);
      const created = await direct(a).expect(201);
      expectMatchesContract("post", "/sessions/{id}/sets", 201, created.body);
      const targetId = created.body.planned_set_id as string;
      const target = await prisma.plannedSet.findUniqueOrThrow({ where: { id: targetId } });
      expect(copiedRaw(target)).toEqual(copiedRaw(f.source));
      const appendReceipt = await receipt(a.client_id);
      expect(appendReceipt.correlationClaims).toEqual([
        expect.objectContaining({
          correlation_id: correlation(a),
          session_id: f.session.id,
          exercise_id: EXERCISE,
          planned_set_id: targetId,
          creation_revision: sourceRevision(target),
        }),
      ]);
      const x = actual(a);
      expect((await sync([x])).applied).toEqual([x.client_id]);
      const before = await state(f.session.id);
      expect(before.facts).toHaveLength(1);
      expect(before.facts[0]).toMatchObject({
        plannedSetId: targetId,
        clientId: x.client_id,
        completed: true,
      });
      expect(Number(before.facts[0].actualWeight)).toBe(73.25);
      const result = await sync([old]);
      expect(result.applied).toEqual([old.client_id]);
      expect(result.conflicts).toEqual([]);
      const after = await state(f.session.id);
      expect({ ...after, ledger: after.ledger.filter((row) => row.id !== old.client_id) }).toEqual(
        before,
      );
      expect(
        after.rows.filter((row) => row.exerciseId === EXERCISE).map((row) => row.setNo),
      ).toEqual([1, 2, 3, 4]);
      expect(after.rows.find((row) => row.id === targetId)).toEqual(snapshotRow(target));
      expect((await receipt(old.client_id)).correlationClaims).toEqual([]);
      const replay = await sync([old]);
      expect(replay).toEqual(result);
      expect(await state(f.session.id)).toEqual(after);
      expect(JSON.stringify(old)).toBe(bytes);
      // A fresh exact existing-row reference includes the append's existing claim. It is not a creator.
      const current = await rows(f.session.id);
      const references: MutationDto = {
        ...old,
        client_id: randomUUID(),
        updated_at: T3,
        payload: {
          exercise_ids: [EXERCISE, OTHER],
          correlations: current.map((row) => ({
            correlation_id: row.clientCorrelationId!,
            exercise_id: row.exerciseId,
            set_no: row.setNo,
          })),
        },
      };
      const kept = await sync([references]);
      expect(kept.applied).toEqual([references.client_id]);
      expect(kept.conflicts).toEqual([]);
      expect(kept.planned_set_mappings).toHaveLength(6);
      const wire = await get(f.session.id);
      for (const mapping of kept.planned_set_mappings)
        expect(mapping.planned_set).toEqual(wire.find((row) => row.id === mapping.planned_set_id));
      const final = await state(f.session.id);
      expect({
        ...final,
        ledger: final.ledger.filter((row) => row.id !== references.client_id),
      }).toEqual(after);
      expect((await receipt(references.client_id)).correlationClaims).toEqual([]);
      expect((await sync([references])).planned_set_mappings).toEqual(kept.planned_set_mappings);
      expect(await state(f.session.id)).toEqual(final);
    },
  );

  it.each(["POST-sync", "sync-POST"])(
    "lost correlated child response replays original intent across %s",
    async (direction) => {
      const f = await fixture();
      const parent = append(f.session.id, f.source);
      // Parent success is committed, but its returned mapping is not applied to any child transport.
      expect((await sync([parent])).applied).toEqual([parent.client_id]);
      const child = append(f.session.id, correlation(parent));
      const original = JSON.stringify(child);
      const adapter = app.getHttpAdapter();
      const originalReply = adapter.reply.bind(adapter);
      let destroyed = 0;
      let committedResponse: unknown;
      const replyObservations: Record<string, unknown>[] = [];
      const reply = jest.spyOn(adapter, "reply").mockImplementation((response, body, status) => {
        const res = response as ServerResponse;
        // Nest sets res.statusCode before the handler and omits reply's optional status argument.
        const effectiveStatus = status ?? res.statusCode;
        const matched =
          res.req.method === "POST" &&
          (direction === "POST-sync"
            ? res.req.url === `/v1/sessions/${f.session.id}/sets` &&
              effectiveStatus === 201 &&
              body?.client_id === child.client_id
            : res.req.url === "/v1/sync" &&
              effectiveStatus === 200 &&
              body?.applied?.includes(child.client_id));
        replyObservations.push({
          method: res.req.method,
          url: res.req.url,
          statusArgument: status ?? null,
          responseStatus: res.statusCode,
          effectiveStatus,
          headersSent: res.headersSent,
          childClientId: child.client_id,
          returnedClientId: body?.client_id ?? null,
          childApplied: Array.isArray(body?.applied) && body.applied.includes(child.client_id),
          matched: Boolean(matched),
        });
        if (matched && destroyed === 0) {
          // Real handler already committed. Drop its actual response before bytes reach the requester.
          expect(res.headersSent).toBe(false);
          committedResponse = structuredClone(body);
          destroyed += 1;
          res.destroy();
          return res;
        }
        return originalReply(response, body, status);
      });
      try {
        await expect(
          direction === "POST-sync" ? direct(child) : syncRequest([child]),
        ).rejects.toMatchObject({ code: "ECONNRESET" });
        expect(destroyed).toBe(1);
      } finally {
        reply.mockRestore();
        console.info(
          "correlated-child-reply-seam",
          JSON.stringify({
            direction,
            adapter: adapter.constructor.name,
            destroyed,
            replyObservations,
          }),
        );
      }
      const target = await prisma.plannedSet.findUniqueOrThrow({
        where: { clientCorrelationId: correlation(child) },
      });
      const parentTarget = await prisma.plannedSet.findUniqueOrThrow({
        where: { clientCorrelationId: correlation(parent) },
      });
      expect(target.setNo).toBe(5);
      expect(copiedRaw(target)).toEqual(copiedRaw(parentTarget));
      const childReceipt = await receipt(child.client_id);
      expect(childReceipt.status).toBe("applied");
      expect(childReceipt.payload).toEqual(child.payload);
      expect(childReceipt.requestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(childReceipt.requestIdentity).toEqual({ session_id: f.session.id, ...child.payload });
      const resultIdentity = {
        correlation_id: correlation(child),
        session_id: f.session.id,
        exercise_id: EXERCISE,
        planned_set_id: target.id,
        creation_revision: sourceRevision(target),
        source_planned_set_id: parentTarget.id,
        source_revision: sourceRevision(parentTarget),
      };
      expect(childReceipt.resultIdentity).toEqual(resultIdentity);
      expect(childReceipt.correlationClaims).toEqual([resultIdentity]);
      console.info(
        "correlated-child-response-loss",
        JSON.stringify({
          direction,
          clientId: child.client_id,
          destroyedBeforeHeaders: destroyed,
          requesterError: "ECONNRESET",
          storedStatus: childReceipt.status,
          plannedSetId: target.id,
        }),
      );
      if (direction === "POST-sync")
        expect(committedResponse).toMatchObject({
          client_id: child.client_id,
          planned_set_id: target.id,
        });
      else
        expect(committedResponse).toMatchObject({
          applied: [child.client_id],
          planned_set_mappings: [expect.objectContaining({ planned_set_id: target.id })],
        });
      // A later parent ACK must not turn the immutable child source into server-ID form.
      const parentAck = await sync([parent]);
      expect(parentAck.planned_set_mappings[0].planned_set_id).toBe(parentTarget.id);
      expect(JSON.stringify(child)).toBe(original);
      // Replay returns CURRENT child projection rather than stored first-response health data.
      await prisma.plannedSet.update({
        where: { id: target.id },
        data: { restSec: 155, targetRir: 4 },
      });
      const x = actual(child);
      expect((await sync([x])).applied).toEqual([x.client_id]);
      const current = (await get(f.session.id)).find((row) => row.id === target.id)!;
      expect(current).toMatchObject({
        rest_sec: 155,
        target_rir: 4,
        performed_set: { actual_weight: 73.25, completed: true },
      });
      expect(current.source_revision).not.toBe(sourceRevision(target));
      const beforeReplay = await state(f.session.id);
      if (direction === "POST-sync") {
        const result = await sync([child]);
        expect(result.applied).toEqual([child.client_id]);
        expect(result.conflicts).toEqual([]);
        expect(result.planned_set_mappings).toEqual([
          { correlation_id: correlation(child), planned_set_id: target.id, planned_set: current },
        ]);
      } else {
        const result = await direct(child).expect(201);
        expectMatchesContract("post", "/sessions/{id}/sets", 201, result.body);
        expect(result.body).toEqual({
          client_id: child.client_id,
          session_id: f.session.id,
          correlation_id: correlation(child),
          planned_set_id: target.id,
          planned_set: current,
        });
      }
      expect((await direct(child).expect(201)).body.planned_set).toEqual(current);
      expect((await sync([child])).planned_set_mappings[0].planned_set).toEqual(current);
      expect(await state(f.session.id)).toEqual(beforeReplay);
      expect(await receipt(child.client_id)).toEqual(childReceipt);
      expect(
        await prisma.plannedSet.count({ where: { clientCorrelationId: correlation(child) } }),
      ).toBe(1);
      expect(await prisma.syncMutation.count({ where: { id: child.client_id } })).toBe(1);
      expect(beforeReplay.rows).toHaveLength(7);
      expect(beforeReplay.facts).toHaveLength(1);
      expect(JSON.stringify(child)).toBe(original);
      expect(child.payload.source).toEqual({ source_correlation_id: correlation(parent) });
    },
  );
});

import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Program, SessionOrigin, SessionStatus } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";

const USER_ID = devUserId();
const MONDAY = "2026-09-14";
type Summary = { id: string; scheduled_date: string; revision: string; focus: string };

describe("weekly focus swap HTTP / actual PostgreSQL", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let program: Program;
  let oldToday: string | undefined;

  beforeAll(async () => {
    oldToday = process.env.AFC_TEST_TODAY;
    process.env.AFC_TEST_TODAY = MONDAY;
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    if (oldToday === undefined) delete process.env.AFC_TEST_TODAY;
    else process.env.AFC_TEST_TODAY = oldToday;
    await app?.close();
  });
  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
    // The auth guard establishes the run-scoped owner before direct fixture writes.
    await request(app.getHttpServer()).get("/v1/programs/current").expect(404);
    program = await newProgram();
  });

  async function newProgram() {
    return prisma.program.create({
      data: {
        userId: USER_ID, goal: "hypertrophy", daysPerWeek: 4, minutesPerDay: 60,
        splitType: "upper_lower", rulesVersion: "2026.08.1",
        startedAt: new Date(`${MONDAY}T00:00:00Z`), totalWeeks: 12, template: [],
      },
    });
  }
  async function session(date: string, region: "upper" | "lower" | "core", options: {
    programId?: string; origin?: SessionOrigin; status?: SessionStatus;
  } = {}) {
    return prisma.workoutSession.create({
      data: {
        programId: options.programId ?? program.id,
        scheduledDate: new Date(`${date}T00:00:00Z`), focus: region,
        status: options.status ?? "scheduled", origin: options.origin ?? "planned",
        plannedSets: { create: {
          exerciseId: {upper: "e_bench_press", lower: "e_back_squat", core: "e_plank"}[region],
          orderIndex: 0, setNo: 1, targetRepsLow: region === "core" ? null : 8,
          targetRepsHigh: region === "core" ? null : 12, targetRir: region === "core" ? null : 2,
          targetTimeLowSec: region === "core" ? 30 : null,
          targetTimeHighSec: region === "core" ? 60 : null,
          restSec: 90, recommendedWeight: region === "core" ? null : 20,
          recommendedReps: region === "core" ? null : 8,
          reasonCode: "BASELINE", confidence: 0.5, rulesVersion: "2026.08.1",
          loadSemantics: "external_load",
        } },
      },
      include: { plannedSets: true },
    });
  }
  const endpoint = (suffix: string) => `/v1/programs/${program.id}/${suffix}`;
  async function current(): Promise<Summary[]> {
    const res = await request(app.getHttpServer()).get(endpoint("weeks/current")).expect(200);
    expect(res.body.week_start).toBe(MONDAY);
    return res.body.sessions;
  }
  async function payload(today: string, target: string) {
    const rows = await current();
    return {
      client_id: randomUUID(), today_session_id: today, target_session_id: target,
      today_revision: rows.find((s) => s.id === today)!.revision,
      target_revision: rows.find((s) => s.id === target)!.revision,
    };
  }
  const post = (body: object) => request(app.getHttpServer()).post(endpoint("week-swaps")).send(body);
  const candidate = () => request(app.getHttpServer()).get(endpoint("week-swaps/candidates"));
  async function snapshot() {
    return prisma.workoutSession.findMany({
      where: { program: { userId: USER_ID } }, orderBy: { id: "asc" },
      include: { plannedSets: { orderBy: { id: "asc" }, include: { performedSets: true } } },
    });
  }
  function expectReason(response: request.Response, reason: string) {
    expect(response.status).toBe(409);
    expect(response.body.error.details.reason).toBe(reason);
  }

  it("current actual endpoint exists and returns persisted identity, date and aggregate revision", async () => {
    const today = await session(MONDAY, "upper");
    const rows = await current();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({id: today.id, scheduled_date: MONDAY, focus: "upper"});
    expect(rows[0].revision).toMatch(/^v1:[a-f0-9]{64}$/);
  });

  it("Monday U / Tuesday L / Thursday U / Friday L rejects Monday-Friday atomically", async () => {
    const a = await session(MONDAY, "upper");
    await session("2026-09-15", "lower");
    await session("2026-09-17", "upper");
    const b = await session("2026-09-18", "lower");
    const body = await payload(a.id, b.id);
    const before = await snapshot();
    expectReason(await post(body), "recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
    const candidates = await candidate().expect(200);
    expect(candidates.body.candidates.find((c: {session: Summary}) => c.session.id === b.id))
      .toMatchObject({ eligible: false, reason: "recovery_gap_violation" });
  });

  it("valid within-week swap changes exactly two scheduled dates; result replay survives later edits", async () => {
    const a = await session(MONDAY, "upper");
    const b = await session("2026-09-17", "lower");
    const body = await payload(a.id, b.id);
    const before = await snapshot();
    const first = await post(body).expect(200);
    expect(first.body.today_session_id).toBe(b.id);
    const after = await snapshot();
    expect(after).toEqual(before.map((s) => ({...s, scheduledDate:
      s.id === a.id ? b.scheduledDate : s.id === b.id ? a.scheduledDate : s.scheduledDate})));
    await prisma.plannedSet.update({where: {id: a.plannedSets[0].id}, data: {restSec: 120}});
    expect((await post(body).expect(200)).body).toEqual(first.body);
    expectReason(await post({...body, target_revision: "changed"}), "idempotency_payload_mismatch");
  });

  it.each(["2026-09-13", "2026-09-21"])("checks boundary neighbor %s", async (boundary) => {
    const a = await session(MONDAY, boundary.endsWith("13") ? "upper" : "lower");
    const b = await session("2026-09-20", boundary.endsWith("13") ? "lower" : "upper");
    await session(boundary, boundary.endsWith("13") ? "lower" : "lower");
    const body = await payload(a.id,b.id);
    const before = await snapshot();
    expectReason(await post(body), "recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
  });

  it("core-only neighbor is in chronology but does not cause recovery conflict", async () => {
    const a = await session(MONDAY, "core");
    await session("2026-09-15", "core");
    const b = await session("2026-09-17", "core");
    await post(await payload(a.id,b.id)).expect(200);
  });

  it("other Program completed/ad_hoc actual neighbor is read without changing it", async () => {
    const older = program;
    await prisma.program.update({ where: { id: older.id }, data: { createdAt: new Date("2026-01-01") } });
    program = await newProgram();
    await session("2026-09-13", "lower", {programId: older.id, origin: "ad_hoc", status: "completed"});
    const a = await session(MONDAY, "upper");
    const b = await session("2026-09-17", "lower");
    const body = await payload(a.id,b.id);
    const before = await snapshot();
    expectReason(await post(body), "recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
  });

  it("unmaterialized next-week template is read-only recovery evidence", async () => {
    const a = await session(MONDAY, "lower");
    const b = await session("2026-09-20", "upper");
    await prisma.program.update({where:{id:program.id},data:{template:[{
      day:"MON",focus:"lower",exercises:[{exercise_id:"e_back_squat",sets:1,reps_low:8,reps_high:12,
        target_rir:2,rest_sec:90,time_low_sec:null,time_high_sec:null}]
    }]}});
    const body = await payload(a.id,b.id);
    const before = await snapshot();
    expectReason(await post(body),"recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
  });

  it("unsupported recovery bundle fails closed", async () => {
    const a = await session(MONDAY,"upper");
    const b = await session("2026-09-17","lower");
    await prisma.program.update({where:{id:program.id},data:{rulesVersion:"2026.09.0"}});
    expectReason(await post(await payload(a.id,b.id)),"recovery_unverifiable");
  });

  it("ad_hoc target is not scheduled for swap", async () => {
    const a = await session(MONDAY,"upper");
    const b = await session("2026-09-17","lower",{origin:"ad_hoc"});
    expectReason(await post(await payload(a.id,b.id)),"not_scheduled");
  });

  it("plan and incomplete performed-row changes invalidate revisions; structural performed reason wins", async () => {
    const a = await session(MONDAY,"upper");
    const b = await session("2026-09-17","lower");
    const body = await payload(a.id,b.id);
    await prisma.plannedSet.update({where:{id:a.plannedSets[0].id},data:{targetRepsLow:9}});
    expectReason(await post(body),"stale_revision");
    await prisma.performedSet.create({data:{plannedSetId:a.plannedSets[0].id,completed:false,
      clientId:randomUUID(),performedAt:new Date()}});
    expectReason(await post(body),"performed_history");
  });

  it("parallel swaps allow exactly one and leave no partial exchange", async () => {
    const a = await session(MONDAY,"upper");
    const b = await session("2026-09-17","lower");
    const body = await payload(a.id,b.id);
    const responses = await Promise.all([post(body),post({...body,client_id:randomUUID()})]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    const after = await snapshot();
    expect(after.find(s=>s.id===a.id)?.scheduledDate).toEqual(b.scheduledDate);
    expect(after.find(s=>s.id===b.id)?.scheduledDate).toEqual(a.scheduledDate);
  });

  it("ambiguous today returns null identity and explicit today eligibility", async () => {
    await session(MONDAY,"upper");
    await session(MONDAY,"lower",{origin:"ad_hoc"});
    await session("2026-09-17","lower");
    const result = await candidate().expect(200);
    expect(result.body).toMatchObject({today_session_id:null,today_revision:null,
      today_eligible:false,today_reason:"ambiguous_schedule"});
  });

  it("commit rechecks a neighbor changed after candidates without either requested revision changing", async () => {
    const a = await session(MONDAY,"upper");
    const neighbor = await session("2026-09-15","core");
    const b = await session("2026-09-17","lower");
    const body = await payload(a.id,b.id);
    const result = await candidate().expect(200);
    expect(result.body.candidates.find((c:{session:Summary})=>c.session.id===b.id).eligible).toBe(true);
    await prisma.plannedSet.update({where:{id:neighbor.plannedSets[0].id},data:{
      exerciseId:"e_back_squat", targetTimeLowSec:null,targetTimeHighSec:null,
      targetRepsLow:8,targetRepsHigh:12,targetRir:2,recommendedReps:8,
    }});
    const before = await snapshot();
    expectReason(await post(body),"recovery_gap_violation");
    expect(await snapshot()).toEqual(before);
  });

  it("readonly precedes performed_history and stale_revision", async () => {
    const a = await session(MONDAY,"upper");
    const b = await session("2026-09-17","lower");
    const body = await payload(a.id,b.id);
    await prisma.workoutSession.update({where:{id:a.id},data:{status:"completed"}});
    await prisma.performedSet.create({data:{plannedSetId:a.plannedSets[0].id,completed:true,
      clientId:randomUUID(),performedAt:new Date()}});
    expectReason(await post(body),"readonly");
  });

  it("body validation, absent today, and missing/foreign ownership fail before mutation", async () => {
    await candidate().expect(404);
    await post({client_id:randomUUID()}).expect(400);
    await post({client_id:randomUUID(),today_session_id:randomUUID(),target_session_id:randomUUID(),
      today_revision:"a",target_revision:"b"}).expect(404);
  });
});

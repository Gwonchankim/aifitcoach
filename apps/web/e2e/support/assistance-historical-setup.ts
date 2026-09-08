/** Owned E2E preparation only. Wire/UI oracles are supplied separately, never inferred here. */
import type { APIRequestContext } from "@playwright/test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect } from "../fixtures";
import { API_V1, seedExternalLoadProgram, todaySession } from "../helpers";
import { assertPositionRun } from "./session-position-observation";
import type { Session } from "../../lib/api";

type HistoricalModule =
  typeof import("../../../api/test/support/assistance-append-historical-fixture");
type HistoricalMode = Parameters<
  HistoricalModule["installAssistanceHistoricalSnapshot"]
>[0]["mode"];
type Evidence = Record<string, unknown>;
const pairs = ["e_assisted_pullup", "e_assisted_dips"];

async function sessionGET(request: APIRequestContext, id: string, evidence: Evidence, key: string) {
  const response = await request.get(`${API_V1}/sessions/${id}`);
  const body = await response.text();
  evidence[key] = { status: response.status(), body };
  expect(response.status()).toBe(200);
  return JSON.parse(body) as Session;
}

/** Calls only the backend's guarded INSERT fixture; no independent DB connection/query/reset. */
export async function prepareHistoricalSnapshot(
  request: APIRequestContext,
  mode: HistoricalMode,
  evidence: Evidence,
) {
  await assertPositionRun(request);
  const me = await request.get(`${API_V1}/me`);
  const profile = (await me.json()) as { id: string };
  evidence.publicOwner = { status: me.status(), id: profile.id };
  expect(me.status()).toBe(200);
  expect(profile.id).toBe(process.env.E2E_DEV_USER_ID);
  await seedExternalLoadProgram(request, { pain_areas: [] });
  const sessionId = await todaySession(request);
  const before = await sessionGET(request, sessionId, evidence, "beforeFixtureGET");
  expect(before.status).toBe("scheduled");
  expect(before.planned_sets.filter((set) => pairs.includes(set.exercise_id))).toEqual([]);

  // Same createRequire boundary as assistance-observation.ts; the fixture owns all DB guards.
  const requireApi = createRequire(path.resolve(process.cwd(), "../api/package.json"));
  const { installAssistanceHistoricalSnapshot } = requireApi(
    "./test/support/assistance-append-historical-fixture.ts",
  ) as HistoricalModule;
  const { Prisma } = requireApi("@prisma/client") as {
    Prisma: { Decimal: new (value: string) => { equals(value: string): boolean } };
  };
  const refusal = async (key: string, invoke: () => Promise<unknown>, expected: string) => {
    const error: unknown = await invoke().then(
      () => null,
      (failure: unknown) => failure,
    );
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    evidence[key] = { code };
    expect(error).toBeInstanceOf(Error);
    expect(code).toBe(expected);
    expect((error as Error).message).toBe(`Historical fixture failed: ${expected}`);
  };
  await refusal(
    "wrongOwnerRefusal",
    () =>
      installAssistanceHistoricalSnapshot({
        sessionId,
        expectedOwnerId: randomUUID(),
        mode,
      }),
    "OWNERSHIP_ENV",
  );
  expect(await sessionGET(request, sessionId, evidence, "afterWrongOwnerGET")).toEqual(before);

  const installed = await installAssistanceHistoricalSnapshot({
    sessionId,
    expectedOwnerId: profile.id,
    mode,
  });
  evidence.fixture = installed;
  expect(installed.committed).toBe(true);
  expect(installed.sessionId).toBe(sessionId);
  expect(installed.ownerId).toBe(profile.id);
  expect(installed.mode).toBe(mode);
  expect(installed.insertedIds).toHaveLength(2);
  expect(new Set(installed.insertedIds).size).toBe(2);
  expect(installed.raw.map((set) => set.id)).toEqual(installed.insertedIds);
  expect(installed.raw.map((set) => set.exerciseId)).toEqual(pairs);
  expect(Object.keys(installed.unchanged.before).sort()).toEqual(
    [
      "planned_sets",
      "programs",
      "workout_sessions",
      "performed_sets",
      "sync_mutations",
      "assistance_audits",
      "access_audits",
      "user_rir_calibration",
      "calibration_set",
      "estimated_1rm",
      "muscle_weekly_load",
      "exercises",
    ].sort(),
  );
  expect(installed.unchanged.after).toEqual(installed.unchanged.before);
  for (const value of Object.values(installed.unchanged.before)) {
    expect(Number.isInteger(value.count)).toBe(true);
    expect(value.count).toBeGreaterThanOrEqual(0);
    expect(value.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  const inserted = installed.inserted as Record<string, unknown>[];
  expect(inserted).toHaveLength(2);
  for (const [index, raw] of installed.raw.entries()) {
    const actual = inserted[index];
    expect(raw).toMatchObject({
      sessionId,
      exerciseId: pairs[index],
      clientCorrelationId: null,
      setNo: 1,
      targetRepsLow: 7,
      targetRepsHigh: 13,
      targetRir: 3,
      restSec: 137,
      targetTimeLowSec: null,
      targetTimeHighSec: null,
      recommendedReps: 9,
      ...(mode === "external"
        ? {
            loadSemantics: "external_load",
            assistanceProvenance: null,
            assistanceStepKg: null,
            rulesVersion: "2026.08.1",
            recommendedWeight: 56.25,
            reasonCode: "ASSISTANCE_MINIMUM_REACHED",
            confidence: 0.63,
          }
        : {
            loadSemantics: "assistance",
            assistanceProvenance: "remediated",
            assistanceStepKg: 2.5,
            rulesVersion: "2026.08.2",
            recommendedWeight: null,
            reasonCode: "ASSISTANCE_CALIBRATION_NEEDED",
            confidence: 0,
          }),
    });
    // Keep the observed JSON representation in evidence; compare Decimal values, not scale rendering.
    const normalized = { ...actual };
    for (const key of ["recommendedWeight", "confidence", "assistanceStepKg"] as const) {
      if (raw[key] === null) expect(actual[key]).toBeNull();
      else {
        expect(actual[key]).not.toBeNull();
        expect(new Prisma.Decimal(String(actual[key])).equals(String(raw[key]))).toBe(true);
      }
      normalized[key] = raw[key];
    }
    expect(normalized).toEqual({ ...raw, updatedAt: actual.updatedAt });
    expect(typeof actual.updatedAt).toBe("string");
    expect(new Date(String(actual.updatedAt)).toISOString()).toBe(actual.updatedAt);
  }
  const after = await sessionGET(request, sessionId, evidence, "afterFixtureGET");
  const insertedIdentity = new Set<string>(installed.insertedIds);
  expect(after.status).toBe("scheduled");
  expect(after.planned_sets.filter((set) => !insertedIdentity.has(set.id))).toEqual(
    before.planned_sets,
  );
  const targets = after.planned_sets.filter((set) => insertedIdentity.has(set.id));
  expect(targets.map((set) => set.id)).toEqual(installed.insertedIds);
  expect(targets.map((set) => set.exercise_id)).toEqual(pairs);
  for (const set of targets) expect(set.performed_set).toBeNull();

  await refusal(
    "existingGroupRefusal",
    () => installAssistanceHistoricalSnapshot({ sessionId, expectedOwnerId: profile.id, mode }),
    "GROUP_EXISTS",
  );
  expect(await sessionGET(request, sessionId, evidence, "afterGroupRefusalGET")).toEqual(after);
  return { sessionId, installed, session: after, targets };
}

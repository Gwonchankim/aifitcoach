import { describe, expect, it } from "vitest";
import type { components, paths } from "../lib/api-types";

// 런타임 호출 없이, 코드젠 타입이 openapi 계약대로 쓰이는지 컴파일 타임으로 검증한다.
type ExercisesOk = paths["/exercises"]["get"]["responses"][200]["content"]["application/json"];
type Exercise = components["schemas"]["Exercise"];
type SyncMutation = components["schemas"]["Mutation"];
type SyncOk = paths["/sync"]["post"]["responses"][200]["content"]["application/json"];
type SyncHeaders = NonNullable<paths["/sync"]["post"]["parameters"]["header"]>;
type HasIdempotencyHeader = "Idempotency-Key" extends keyof SyncHeaders ? true : false;

describe("api-types (openapi 코드젠)", () => {
  it("GET /exercises 200 응답 타입을 그대로 쓸 수 있다", () => {
    const body: ExercisesOk = {
      items: [
        {
          id: "e_bench_press",
          name_ko: "바벨 벤치프레스",
          name_en: "Barbell Bench Press",
          movement_pattern: "horizontal_push",
          primary_muscles: ["chest"],
          equipment: "barbell",
          difficulty: "intermediate",
          mechanic: "compound",
          region: "upper",
          metric: "reps",
          step_kg: 2.5,
          substitutions: ["e_incline_db_press"],
          rep_range_low: 5,
          rep_range_high: 10,
          default_time_low_sec: null,
          default_time_high_sec: null,
          media_url: null,
        },
      ],
      next_cursor: null,
    };
    const first: Exercise | undefined = body.items[0];

    expect(first?.id).toBe("e_bench_press");
    expect(body.next_cursor).toBeNull();
  });

  it("/sync는 mutation/entity ID를 분리하고 opaque cursor를 문자열로 생성한다", () => {
    const mutation: SyncMutation = {
      client_id: "8f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
      entity: "performed_set",
      entity_id: "7d410e45-f83e-4951-82c7-c2cf6a09d536",
      op: "upsert",
      updated_at: "2026-08-15T08:00:00.000Z",
      payload: { actual_weight: 50, actual_reps: 8, completed: true },
    };
    const response: SyncOk = {
      applied: [mutation.client_id],
      conflicts: [],
      changes: [
        {
          entity: mutation.entity,
          entity_id: mutation.entity_id,
          op: mutation.op,
          data: mutation.payload,
          server_seq: "42",
        },
      ],
      planned_set_mappings: [],
      next_cursor: "42",
    };
    const hasDuplicateTransportKey: HasIdempotencyHeader = false;

    expect(response.next_cursor).toBe("42");
    expect(hasDuplicateTransportKey).toBe(false);
  });

  it("append uses the same source identity over POST/sync and completion carries committed actual UUIDs", () => {
    type AppendBody =
      paths["/sessions/{id}/sets"]["post"]["requestBody"]["content"]["application/json"];
    type AppendHeaders = NonNullable<paths["/sessions/{id}/sets"]["post"]["parameters"]["header"]>;
    const duplicateKey: "Idempotency-Key" extends keyof AppendHeaders ? true : false = false;
    const request: AppendBody = {
      client_id: "11111111-1111-4111-8111-111111111111",
      exercise_id: "e_bench_press",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      source: {
        source_planned_set_id: "33333333-3333-4333-8333-333333333333",
        source_revision: "opaque",
      },
    };
    const append: SyncMutation = {
      client_id: request.client_id,
      entity: "session_set",
      entity_id: request.client_id,
      op: "upsert",
      updated_at: "2026-08-14T10:00:00.000Z",
      payload: {
        exercise_id: request.exercise_id,
        correlation_id: request.correlation_id,
        source: request.source,
      },
    };
    const completion: SyncMutation = {
      client_id: request.correlation_id,
      entity: "session",
      entity_id: request.client_id,
      op: "upsert",
      updated_at: "2026-08-14T10:00:01.000Z",
      payload: { status: "completed" },
      append_dependencies: {
        session_id: request.client_id,
        client_ids: [append.client_id],
        performed_client_ids: [request.correlation_id],
      },
    };
    const eligibility: components["schemas"]["AppendEligibility"] = {
      version: 1,
      source_revision: "opaque",
      cohort_revision: "opaque-cohort",
      status: "allowed",
      reason: null,
    };
    expect("source" in append.payload && append.payload.source).toEqual(request.source);
    expect(completion.append_dependencies?.performed_client_ids).toEqual([request.correlation_id]);
    expect(eligibility.reason).toBeNull();
    expect(duplicateKey).toBe(false);
  });

  it("routine changes keep session scope and exact nullable correlation tombstones", () => {
    const tombstone: components["schemas"]["PlannedSetTombstone"] = {
      planned_set_id: "11111111-1111-4111-8111-111111111111",
      correlation_id: null,
      exercise_id: "e_bench_press",
    };
    const change: SyncOk["changes"][number] = {
      entity: "session_routine",
      entity_id: "22222222-2222-4222-8222-222222222222",
      op: "delete",
      data: { tombstones: [tombstone] },
      server_seq: "9007199254740993",
    };
    const removedId: string | undefined = change.data?.tombstones?.[0]?.planned_set_id;
    expect(removedId).toBe(tombstone.planned_set_id);
    expect(change.entity_id).not.toBe(removedId);
    expect(change.data?.tombstones?.[0]?.correlation_id).toBeNull();
  });
});

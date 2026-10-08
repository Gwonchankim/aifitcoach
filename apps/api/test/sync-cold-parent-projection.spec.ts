import { SyncService } from "../src/sync/sync.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { PlannedSetFactory } from "../src/programs/planned-set.factory";
import { SessionsService } from "../src/sessions/sessions.service";
import { RecommendationService } from "../src/recommendation/recommendation.service";
import { SessionSetAppendService } from "../src/sessions/session-set-append.service";
import { SessionDependencyService } from "../src/sync/session-dependency";

const USER = "00000000-0000-4000-8000-000000000001";
const SET = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-000000000003";
function receipt(entityType = "performed_set", op = "upsert", seq = 1n) {
  return {
    id: `receipt-${seq}`,
    entityType,
    entityId: SET,
    op,
    payload: { completed: true },
    serverSeq: seq,
    requestHash: "unchanged-request-hash",
    requestIdentity: { client_id: "original-id" },
  };
}
function subject(rows: ReturnType<typeof receipt>[], parents: { id: string; sessionId: string }[]) {
  const prisma = {
    syncMutation: { findMany: jest.fn().mockResolvedValue(rows) },
    plannedSet: { findMany: jest.fn().mockResolvedValue(parents) },
  };
  return {
    prisma,
    service: new SyncService(
      prisma as unknown as PrismaService,
      {} as PlannedSetFactory,
      {} as SessionsService,
      {} as RecommendationService,
      {} as SessionSetAppendService,
      {} as SessionDependencyService,
    ),
  };
}
describe("cold performed change parent projection", () => {
  it("projects deduped owner ids outside the payload, including delete data:null, without changing receipt bytes", async () => {
    const rows = [
      receipt(),
      receipt("performed_set", "delete", 2n),
      receipt("session", "upsert", 3n),
    ];
    const before = JSON.stringify(rows, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    const { service, prisma } = subject(rows, [{ id: SET, sessionId: SESSION }]);
    const response = await service.sync(USER, { mutations: [] }, new Date("2026-08-14"));
    expect(response.changes[0]).toMatchObject({
      entity: "performed_set",
      entity_id: SET,
      session_id: SESSION,
    });
    expect(response.changes[1]).toMatchObject({
      entity: "performed_set",
      session_id: SESSION,
      op: "delete",
      data: null,
    });
    expect(response.changes[2]).not.toHaveProperty("session_id");
    expect(response.changes[0].data).not.toHaveProperty("session_id");
    expect(prisma.plannedSet.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.plannedSet.findMany).toHaveBeenCalledWith({
      where: { id: { in: [SET] }, session: { program: { userId: USER } } },
      select: { id: true, sessionId: true },
    });
    expect(
      JSON.stringify(rows, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
    ).toBe(before);
    // Parent metadata may differ across deployment or after the old planned row disappears.
    // The same stored receipt, hash, idempotency identity, ACK and cursor must not differ.
    prisma.plannedSet.findMany.mockResolvedValue([]);
    const absent = await service.sync(USER, { mutations: [] }, new Date("2026-08-14"));
    expect(absent.changes[0]).toHaveProperty("session_id", null);
    expect(absent.next_cursor).toBe(response.next_cursor);
    expect(absent.applied).toEqual(response.applied);
    expect(absent.conflicts).toEqual(response.conflicts);
    const withoutParent = (changes: typeof response.changes) =>
      changes.map((item) => {
        const { session_id: _parent, ...change } = item as typeof item & {
          session_id?: string | null;
        };
        return change;
      });
    expect(withoutParent(absent.changes)).toEqual(withoutParent(response.changes));
    expect(
      JSON.stringify(rows, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
    ).toBe(before);
  });
  it("does not issue a parent query for other entity kinds", async () => {
    const { service, prisma } = subject([receipt("session")], []);
    const response = await service.sync(USER, { mutations: [] }, new Date("2026-08-14"));
    expect(response.changes[0]).not.toHaveProperty("session_id");
    expect(prisma.plannedSet.findMany).not.toHaveBeenCalled();
  });
});

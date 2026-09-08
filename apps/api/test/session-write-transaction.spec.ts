/** Pure ordering/retry tests. DB barrier/serialization evidence remains in owned integration gates. */
import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../src/prisma/prisma.service";
import {
  lockCorrelationClaims,
  lockMutationIdentities,
  lockReceiptRows,
  retrySessionWrite,
  sessionWriteTransaction,
  SessionLockHintChanged,
  type LockedSession,
} from "../src/sessions/session-write-transaction";

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const PROGRAM = "bbbbbbbb-1111-4111-8111-111111111111";
const CLIENT = "cccccccc-1111-4111-8111-111111111111";
const CORRELATION = "dddddddd-1111-4111-8111-111111111111";

function harness() {
  const calls: { statement: string; values: unknown[] }[] = [];
  const capture = async (sql: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    calls.push({
      statement: Array.isArray(sql) ? sql.join("?") : (sql as Prisma.Sql).sql,
      values: Array.isArray(sql) ? values : (sql as Prisma.Sql).values,
    });
    return [];
  };
  const current = { id: SESSION, programId: PROGRAM } as LockedSession;
  const read = jest.fn(async () => current);
  const tx = {
    $executeRaw: jest.fn(capture),
    $queryRaw: jest.fn(capture),
    workoutSession: { findFirst: read },
  } as unknown as Prisma.TransactionClient;
  const hint = jest.fn(async () => ({ id: SESSION, programId: PROGRAM }));
  const transaction = jest.fn(
    async (
      work: (client: Prisma.TransactionClient) => Promise<unknown>,
      _options?: { isolationLevel: Prisma.TransactionIsolationLevel },
    ) => work(tx),
  );
  const prisma = {
    workoutSession: { findFirst: hint },
    $transaction: transaction,
  } as unknown as PrismaService;
  return { calls, current, read, tx, hint, transaction, prisma };
}

describe("M3 common session write ordering (pure, no DB)", () => {
  it("deduplicates and sorts existing client/entity namespace keys before taking any row lock", async () => {
    const { tx, calls } = harness();
    await lockMutationIdentities(tx, "owner", [
      { clientId: CLIENT.toUpperCase(), entity: "session_set", entityId: SESSION.toUpperCase() },
      { clientId: CLIENT, entity: "session_set", entityId: SESSION },
      { entity: "performed_set", entityId: CORRELATION },
    ]);
    expect(calls.map((call) => call.values[0])).toEqual(
      [
        JSON.stringify(["client", CLIENT]),
        JSON.stringify(["entity", "owner", "performed_set", CORRELATION]),
        JSON.stringify(["entity", "owner", "session_set", SESSION]),
      ].sort(),
    );
    expect(calls.every((call) => call.statement.includes("pg_advisory_xact_lock"))).toBe(true);
  });

  it("locks program → session → planned before reread/correlation/receipt, with no late client key", async () => {
    const h = harness();
    const result = await sessionWriteTransaction(
      h.prisma,
      "owner",
      SESSION,
      [{ clientId: CLIENT, entity: "session_set", entityId: SESSION }],
      async (tx, current) => {
        expect(current).toBe(h.current);
        expect(h.calls.map((call) => call.statement)).toEqual([
          expect.stringContaining("pg_advisory_xact_lock"),
          expect.stringContaining("pg_advisory_xact_lock"),
          expect.stringContaining("FROM programs"),
          expect.stringContaining("FROM workout_sessions"),
          expect.stringContaining("FROM planned_sets"),
        ]);
        expect(h.read).toHaveBeenCalledTimes(1);
        await lockCorrelationClaims(tx, [CORRELATION.toUpperCase(), CORRELATION]);
        await lockReceiptRows(tx, [CLIENT, CLIENT.toUpperCase()]);
        return "committed";
      },
    );
    expect(result).toBe("committed");
    expect(h.calls).toHaveLength(7);
    expect(h.calls[5].values).toEqual([JSON.stringify(["correlation", CORRELATION])]);
    expect(h.calls[6].statement).toContain("FROM sync_mutations");
    expect(h.transaction.mock.calls[0]).toHaveLength(2);
    expect(h.transaction.mock.calls[0][1]).toEqual({
      // Each authoritative read follows all row locks; a pre-wait MVCC snapshot is not authority.
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  });

  it("cannot use a stale program hint or continue by taking an earlier lock late", async () => {
    const h = harness();
    h.current.programId = CORRELATION;
    const work = jest.fn();
    await expect(
      sessionWriteTransaction(h.prisma, "owner", SESSION, [], work),
    ).rejects.toBeInstanceOf(SessionLockHintChanged);
    expect(h.hint).toHaveBeenCalledTimes(5);
    expect(h.transaction).toHaveBeenCalledTimes(5);
    expect(work).not.toHaveBeenCalled();
  });

  it("malformed or unowned session is rejected before transaction locks", async () => {
    const h = harness();
    await expect(
      sessionWriteTransaction(h.prisma, "owner", "invalid", [], jest.fn()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.hint).not.toHaveBeenCalled();
    h.hint.mockResolvedValueOnce(null as unknown as { id: string; programId: string });
    await expect(
      sessionWriteTransaction(h.prisma, "owner", SESSION, [], jest.fn()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it.each(["P2034", "P2002"])(
    "%s retries at most five total attempts; propagates the exact final failure",
    async (code) => {
      const error = new Prisma.PrismaClientKnownRequestError("owned synthetic conflict", {
        code,
        clientVersion: "6.19.3",
      });
      const operation = jest.fn(async () => {
        throw error;
      });
      await expect(retrySessionWrite(operation)).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(5);
    },
  );
  it("non-retryable failures propagate once and successful retries return the real result", async () => {
    const error = new Error("do not hide");
    const failure = jest.fn(async () => {
      throw error;
    });
    await expect(retrySessionWrite(failure)).rejects.toBe(error);
    expect(failure).toHaveBeenCalledTimes(1);
    const success = jest
      .fn()
      .mockRejectedValueOnce(new SessionLockHintChanged())
      .mockResolvedValueOnce("ok");
    expect(await retrySessionWrite(success)).toBe("ok");
    expect(success).toHaveBeenCalledTimes(2);
  });

  it("a hint-owning adapter has five total transactions, not five nested sets of retries", async () => {
    const h = harness();
    const failure = new SessionLockHintChanged();
    const work = jest.fn(async () => {
      throw failure;
    });
    await expect(
      retrySessionWrite(() => sessionWriteTransaction(h.prisma, "owner", SESSION, [], work, false)),
    ).rejects.toBe(failure);
    expect(h.transaction).toHaveBeenCalledTimes(5);
    expect(h.hint).toHaveBeenCalledTimes(5);
    expect(work).toHaveBeenCalledTimes(5);
  });

  it("raw SQL P2010/40001 retries from a fresh hint with the existing five-total budget", async () => {
    const h = harness();
    const error = new Prisma.PrismaClientKnownRequestError(
      "could not serialize access due to concurrent update",
      {
        code: "P2010",
        clientVersion: "6.19.3",
        meta: { code: "40001" },
      },
    );
    h.transaction.mockRejectedValue(error);
    await expect(sessionWriteTransaction(h.prisma, "owner", SESSION, [], jest.fn())).rejects.toBe(
      error,
    );
    expect(h.hint).toHaveBeenCalledTimes(5);
    expect(h.transaction).toHaveBeenCalledTimes(5);
  });

  it.each([undefined, "23505", "22003", "40P01"])(
    "P2010 with other SQLSTATE %s propagates once unchanged",
    async (code) => {
      const error = new Prisma.PrismaClientKnownRequestError("other raw query failure", {
        code: "P2010",
        clientVersion: "6.19.3",
        ...(code ? { meta: { code } } : {}),
      });
      const operation = jest.fn(async () => {
        throw error;
      });
      await expect(retrySessionWrite(operation)).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
    },
  );
});

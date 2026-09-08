import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isUtcToday } from "../common/date/utc-day";
import {
  SESSION_APPEND_REASONS,
  type SessionAppendReason,
} from "../common/http/session-append-conflict";
import { PrismaService } from "../prisma/prisma.service";
import type { AppendSetDto } from "./dto/append-set.dto";
import {
  appendIntentHash,
  copySessionSetSnapshot,
  isAppendCohortSafe,
  sourceRevision,
  validateRawSessionSetSnapshot,
} from "./session-set-snapshot";
import {
  identityObject,
  readCorrelationClaims,
  type CorrelationClaim,
} from "./session-set-receipt";
import {
  lockCorrelationClaims,
  lockReceiptRows,
  sessionWriteTransaction,
} from "./session-write-transaction";

export type AppendApplyResult =
  | {
      status: "applied";
      clientId: string;
      sessionId: string;
      correlationId: string;
      plannedSetId: string;
    }
  | { status: "pending" | "conflict"; reason: SessionAppendReason | "validation_failed" };

/** One ledger/atomic domain path for direct POST and the subsequent sync topology adapter. */
@Injectable()
export class SessionSetAppendService {
  constructor(private readonly prisma: PrismaService) {}

  async apply(
    userId: string,
    sessionId: string,
    request: AppendSetDto,
    transportUpdatedAt?: string,
  ): Promise<AppendApplyResult> {
    const clientId = request.client_id.toLowerCase();
    const correlationId = request.correlation_id.toLowerCase();
    const requestHash = appendIntentHash(sessionId, request);
    // Preserve source representation/case and the original transport intent in storage.
    const payload = {
      exercise_id: request.exercise_id,
      correlation_id: request.correlation_id,
      source: { ...request.source },
    } satisfies Prisma.InputJsonObject;
    return sessionWriteTransaction(
      this.prisma,
      userId,
      sessionId,
      [{ clientId, entity: "session_set", entityId: sessionId }],
      async (tx, session) => {
        const sourceCorrelationId =
          "source_correlation_id" in request.source
            ? request.source.source_correlation_id.toLowerCase()
            : undefined;
        const sourceIdentity = request.source;
        const serverSourceCorrelation =
          "source_planned_set_id" in sourceIdentity
            ? session.plannedSets.find(
                (row) => row.id === sourceIdentity.source_planned_set_id.toLowerCase(),
              )?.clientCorrelationId
            : null;
        const correlationIds = [
          correlationId,
          ...[sourceCorrelationId, serverSourceCorrelation].filter(
            (id): id is string => typeof id === "string",
          ),
        ];
        await lockCorrelationClaims(tx, correlationIds);
        const claimHints = await readCorrelationClaims(tx, correlationIds);
        await lockReceiptRows(tx, [clientId, ...claimHints.map((row) => row.receipt.id)]);
        const claims = await readCorrelationClaims(tx, correlationIds);
        const existing = await tx.syncMutation.findUnique({ where: { id: clientId } });
        if (
          existing &&
          (existing.userId !== userId ||
            existing.entityType !== "session_set" ||
            existing.requestHash !== requestHash)
        )
          return { status: "conflict", reason: "idempotency_payload_mismatch" };
        const applied = (plannedSetId: string): AppendApplyResult => ({
          status: "applied",
          clientId: request.client_id,
          sessionId: session.id,
          correlationId,
          plannedSetId,
        });
        if (existing?.status === "applied") {
          const saved = identityObject(existing.resultIdentity);
          const target = session.plannedSets.find(
            (row) =>
              row.id === saved.planned_set_id &&
              row.exerciseId === request.exercise_id &&
              row.clientCorrelationId === correlationId,
          );
          return target
            ? applied(target.id)
            : { status: "conflict", reason: "append_target_removed" };
        }
        if (existing?.status === "conflict") {
          return { status: "conflict", reason: storedReason(existing.conflictReason) };
        }
        const targetClaim = claims.find(
          (row) => row.claim.correlation_id === correlationId && row.receipt.id !== clientId,
        );
        const liveCollision = await tx.plannedSet.findUnique({
          where: { clientCorrelationId: correlationId },
          select: { id: true },
        });
        const claim: CorrelationClaim = {
          correlation_id: correlationId,
          session_id: session.id,
          exercise_id: request.exercise_id,
          planned_set_id: null,
          creation_revision: null,
        };
        const persist = async (
          status: "applied" | "pending" | "conflict",
          reason: SessionAppendReason | "validation_failed" | null,
          result?: CorrelationClaim & { source_planned_set_id: string; source_revision: string },
          reserve = true,
        ): Promise<void> => {
          const data = {
            status,
            requestHash,
            requestIdentity: existing
              ? identityObject(existing.requestIdentity)
              : { session_id: session.id, ...payload },
            payload: existing ? identityObject(existing.payload) : payload,
            conflictReason: reason,
            appliedAt: status === "applied" ? new Date() : null,
            correlationClaims: reserve ? [{ ...(result ?? claim) }] : Prisma.DbNull,
            resultIdentity: result ? { ...result } : Prisma.DbNull,
          };
          if (existing) await tx.syncMutation.update({ where: { id: clientId }, data });
          else
            await tx.syncMutation.create({
              data: {
                ...data,
                id: clientId,
                userId,
                entityType: "session_set",
                entityId: session.id,
                op: "upsert",
                clientUpdatedAt: transportUpdatedAt ? new Date(transportUpdatedAt) : new Date(),
              },
            });
        };
        const reject = async (
          reason: SessionAppendReason | "validation_failed",
          reserve = true,
        ): Promise<AppendApplyResult> => {
          const status = reason === "unresolved_parent" ? "pending" : "conflict";
          await persist(status, reason, undefined, reserve);
          return { status, reason };
        };
        if (targetClaim || liveCollision) return reject("correlation_mismatch", false);
        if (!isUtcToday(session.scheduledDate)) return reject("readonly");

        let sourceId: string;
        let expectedRevision: string;
        if (sourceCorrelationId) {
          const parent = claims.find((row) => row.claim.correlation_id === sourceCorrelationId);
          if (!parent) return reject("unresolved_parent");
          if (
            parent.receipt.userId !== userId ||
            parent.claim.session_id !== session.id ||
            parent.claim.exercise_id !== request.exercise_id
          )
            return reject("correlation_mismatch");
          if (parent.receipt.status === "pending") return reject("unresolved_parent");
          if (parent.receipt.status !== "applied") return reject("source_removed");
          if (!parent.claim.planned_set_id) {
            const legacyLive = session.plannedSets.some(
              (row) => row.clientCorrelationId === sourceCorrelationId,
            );
            return reject(legacyLive ? "source_changed" : "source_removed");
          }
          sourceId = parent.claim.planned_set_id;
          if (!parent.claim.creation_revision) return reject("source_changed");
          expectedRevision = parent.claim.creation_revision;
        } else if ("source_planned_set_id" in request.source) {
          sourceId = request.source.source_planned_set_id.toLowerCase();
          expectedRevision = request.source.source_revision;
        } else return reject("validation_failed");
        const source = session.plannedSets.find((row) => row.id === sourceId);
        if (!source) return reject("source_removed");
        if (source.exerciseId !== request.exercise_id) return reject("correlation_mismatch");
        if (validateRawSessionSetSnapshot(source).status !== "valid")
          return reject("validation_failed");
        if (sourceRevision(source) !== expectedRevision) return reject("source_changed");
        const rows = session.plannedSets
          .filter((row) => row.exerciseId === request.exercise_id)
          .sort((a, b) => a.setNo - b.setNo);
        if (rows.some((row, index) => row.setNo !== index + 1 || row.setNo > 10))
          return reject("set_number_gap");
        if (rows.length >= 10) return reject("set_cap_reached");
        if (
          !isAppendCohortSafe(
            { userId, sessionId: session.id, exerciseId: request.exercise_id, rows },
            source.id,
          )
        )
          return reject("unsafe_assistance_snapshot");
        const created = await tx.plannedSet.create({
          data: {
            ...copySessionSetSnapshot(source),
            sessionId: session.id,
            exerciseId: request.exercise_id,
            setNo: rows.length + 1,
            clientCorrelationId: correlationId,
          },
        });
        await persist("applied", null, {
          ...claim,
          planned_set_id: created.id,
          creation_revision: sourceRevision(created),
          source_planned_set_id: source.id,
          source_revision: expectedRevision,
        });
        return applied(created.id);
      },
    );
  }
}

function storedReason(reason: string | null): SessionAppendReason | "validation_failed" {
  const reasons: readonly string[] = [...SESSION_APPEND_REASONS, "validation_failed"];
  if (!reason || !reasons.includes(reason)) throw new Error("Missing append receipt reason");
  return reason as SessionAppendReason | "validation_failed";
}

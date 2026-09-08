import { createHash } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type SyncMutation } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { identityObject } from "../sessions/session-set-receipt";
import { clientMutationCandidates, isServerSessionEditEvent } from "../sessions/session-edit-event";
import {
  lockCorrelationClaims,
  lockReceiptRows,
  retrySessionWrite,
  SessionLockHintChanged,
  sessionWriteTransaction,
} from "../sessions/session-write-transaction";
import type { MutationDto } from "./dto/sync-request.dto";

export type DependencyConflict = {
  client_id: string;
  entity_id: string;
  reason: string;
  retryable?: boolean;
  cause_client_id?: string;
  cause_reason?: string;
};
export type MutationResult = {
  applied: boolean;
  sessionId?: string;
  conflict?: DependencyConflict;
};
type Writer = (
  tx: Prisma.TransactionClient,
  userId: string,
  mutation: MutationDto,
) => Promise<void>;

/** Original intent/hash and the canonical logical LWW key are deliberately different fields. */
@Injectable()
export class SessionDependencyService {
  constructor(private readonly prisma: PrismaService) {}

  async apply(
    userId: string,
    original: MutationDto,
    write: Writer,
    compare: (mutation: MutationDto, latest: SyncMutation) => number,
  ): Promise<MutationResult> {
    const dependencies = original.append_dependencies!;
    const sessionId = dependencies.session_id.toLowerCase();
    const clientId = original.client_id.toLowerCase();
    const appendIds = dependencies.client_ids.map((id) => id.toLowerCase()).sort();
    const performedIds = (dependencies.performed_client_ids ?? [])
      .map((id) => id.toLowerCase())
      .sort();
    const identity = {
      client_id: original.client_id,
      entity: original.entity,
      entity_id: original.entity_id,
      op: original.op,
      updated_at: original.updated_at,
      append_dependencies: {
        session_id: sessionId,
        client_ids: appendIds,
        ...(dependencies.performed_client_ids === undefined
          ? {}
          : { performed_client_ids: performedIds }),
      },
    };
    const requestHash = createHash("sha256")
      .update(canonical({ ...identity, payload: original.payload }))
      .digest("hex");
    const conflict = (reason: string): DependencyConflict => ({
      client_id: original.client_id,
      entity_id: original.entity_id,
      reason,
      // This adapter has append dependencies. Mark only the verified intrinsic missing X
      // target, including its immutable conflict replay; ordinary terminals keep their wire.
      ...(original.entity === "performed_set" && reason === "append_target_removed"
        ? { retryable: false }
        : {}),
    });
    return retrySessionWrite(async () => {
      const hintedParents = await this.prisma.syncMutation.findMany({
        where: { id: { in: appendIds } },
      });
      const hintedTarget =
        original.entity === "performed_set"
          ? await resolveTarget(this.prisma, userId, sessionId, original.entity_id, hintedParents)
          : sessionId;
      const correlationIds = hintedParents.flatMap((row) => {
        const id = identityObject(row.resultIdentity).correlation_id;
        return typeof id === "string" ? [id] : [];
      });
      try {
        return await sessionWriteTransaction(
          this.prisma,
          userId,
          sessionId,
          [
            { clientId, entity: original.entity, entityId: original.entity_id },
            ...(hintedTarget ? [{ entity: original.entity, entityId: hintedTarget }] : []),
          ],
          async (tx, session) => {
            await lockCorrelationClaims(tx, [original.entity_id, ...correlationIds]);
            await lockReceiptRows(tx, [clientId, ...appendIds, ...performedIds]);
            const all = await tx.syncMutation.findMany({
              where: { id: { in: [clientId, ...appendIds, ...performedIds] } },
            });
            const byId = new Map(all.map((row) => [row.id, row]));
            const existing = byId.get(clientId);
            if (
              existing &&
              (isServerSessionEditEvent(existing) ||
                existing.userId !== userId ||
                existing.requestHash !== requestHash)
            )
              return { applied: false, conflict: conflict("client_id_mismatch") };
            if (existing?.status === "applied") return { applied: true, sessionId };
            if (existing?.status === "conflict")
              return {
                applied: false,
                conflict: conflict(existing.conflictReason ?? "stale_update"),
              };

            const persist = async (
              status: "pending" | "conflict" | "applied",
              reason: string | null,
              targetId?: string,
            ) => {
              const data = {
                status,
                requestHash,
                requestIdentity: identity,
                dependencyIdentity: identity.append_dependencies,
                entityId: status === "applied" ? targetId! : original.entity_id,
                // Health payload follows the old applied policy only after its fact commits.
                payload:
                  status === "applied" ? (original.payload as Prisma.InputJsonObject) : identity,
                conflictReason: reason,
                appliedAt: status === "applied" ? new Date() : null,
                resultIdentity:
                  status === "applied"
                    ? {
                        session_id: sessionId,
                        ...(original.entity === "performed_set"
                          ? { planned_set_id: targetId! }
                          : {}),
                      }
                    : Prisma.DbNull,
              };
              if (existing) await tx.syncMutation.update({ where: { id: clientId }, data });
              else
                await tx.syncMutation.create({
                  data: {
                    ...data,
                    id: clientId,
                    userId,
                    entityType: original.entity,
                    op: original.op,
                    clientUpdatedAt: new Date(original.updated_at),
                  },
                });
            };
            const terminal = async (reason: string): Promise<MutationResult> => {
              await persist("conflict", reason);
              return { applied: false, conflict: conflict(reason) };
            };
            const deferred = async (
              cause?: SyncMutation,
              reason?: string,
            ): Promise<MutationResult> => {
              const blocked = cause !== undefined && reason !== undefined;
              const code = blocked ? "dependent_conflict" : "unresolved_parent";
              await persist("pending", code);
              return {
                applied: false,
                conflict: {
                  ...conflict(code),
                  retryable: !blocked,
                  ...(blocked ? { cause_client_id: cause.id, cause_reason: reason } : {}),
                },
              };
            };
            if (original.entity === "session" && original.entity_id.toLowerCase() !== sessionId)
              return terminal("validation_failed");
            const parents: SyncMutation[] = [];
            for (const id of appendIds) {
              const parent = byId.get(id);
              if (!parent) return deferred();
              if (
                isServerSessionEditEvent(parent) ||
                parent.userId !== userId ||
                parent.entityType !== "session_set" ||
                parent.entityId !== sessionId
              )
                return terminal("validation_failed");
              if (parent.status === "pending") return deferred();
              if (parent.status === "conflict")
                return deferred(parent, parent.conflictReason ?? "conflict");
              parents.push(parent);
            }
            const target =
              original.entity === "performed_set"
                ? await resolveTarget(tx, userId, sessionId, original.entity_id, parents)
                : sessionId;
            if (target !== hintedTarget) throw new SessionLockHintChanged();
            const parentTargets = new Set(
              parents.map((row) => identityObject(row.resultIdentity).planned_set_id),
            );
            if (original.entity === "performed_set") {
              if (!target || !parentTargets.has(target)) return terminal("validation_failed");
              if (!session.plannedSets.some((row) => row.id === target))
                return terminal("append_target_removed");
            }
            for (const id of performedIds) {
              const actual = byId.get(id);
              if (!actual) return deferred();
              const scope =
                identityObject(actual.resultIdentity).session_id ??
                identityObject(actual.dependencyIdentity).session_id ??
                session.plannedSets.find((row) => row.id === actual.entityId)?.sessionId;
              if (
                isServerSessionEditEvent(actual) ||
                actual.userId !== userId ||
                actual.entityType !== "performed_set" ||
                scope !== sessionId
              )
                return terminal("validation_failed");
              if (actual.status === "pending") return deferred();
              if (actual.status === "conflict")
                return deferred(actual, actual.conflictReason ?? "stale_update");
              if (!parentTargets.has(actual.entityId)) return terminal("validation_failed");
            }
            if (original.entity === "session") {
              const removedParent = parents.find(
                (row) =>
                  !session.plannedSets.some(
                    (set) => set.id === identityObject(row.resultIdentity).planned_set_id,
                  ),
              );
              if (removedParent) return deferred(removedParent, "append_target_removed");
            }
            const canonicalMutation = { ...original, entity_id: target! };
            const latest = await tx.syncMutation.findFirst({
              where: {
                ...clientMutationCandidates(sessionId),
                userId,
                entityType: original.entity,
                entityId: target!,
                status: "applied",
              },
              orderBy: [{ clientUpdatedAt: "desc" }, { id: "desc" }],
            });
            if (latest && compare(canonicalMutation, latest) <= 0) return terminal("stale_update");
            try {
              await write(tx, userId, canonicalMutation);
            } catch (error) {
              // These writer guards run before their first mutation. Other errors roll back the tx.
              if (error instanceof BadRequestException) return terminal("validation_failed");
              if (error instanceof NotFoundException) return terminal("append_target_removed");
              throw error;
            }
            await persist("applied", null, target!);
            return { applied: true, sessionId };
          },
          false,
        );
      } catch (error) {
        // Ownership/nonexistent session rejection occurs before entering a scoped write transaction.
        if (error instanceof BadRequestException || error instanceof NotFoundException) {
          const reason = error instanceof BadRequestException ? "validation_failed" : "not_found";
          return { applied: false, conflict: conflict(reason) };
        }
        throw error;
      }
    });
  }
}

async function resolveTarget(
  tx: Pick<Prisma.TransactionClient, "plannedSet">,
  userId: string,
  sessionId: string,
  originalId: string,
  parents: SyncMutation[],
): Promise<string | undefined> {
  const id = originalId.toLowerCase();
  const live = await tx.plannedSet.findFirst({
    where: {
      sessionId,
      session: { program: { userId } },
      OR: [{ id }, { clientCorrelationId: id }],
    },
    select: { id: true },
  });
  if (live) return live.id;
  for (const parent of parents) {
    if (
      parent.userId !== userId ||
      parent.entityId !== sessionId ||
      parent.entityType !== "session_set"
    )
      continue;
    const result = identityObject(parent.resultIdentity);
    if (
      (result.correlation_id === id || result.planned_set_id === id) &&
      typeof result.planned_set_id === "string"
    )
      return result.planned_set_id;
  }
  return undefined;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

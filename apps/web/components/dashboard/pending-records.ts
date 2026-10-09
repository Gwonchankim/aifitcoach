import { sessionDb } from "../session/session-db";

/** Drafts supply membership/latest identity; only the outbox proves an unsent completion. */
export async function pendingCompletedCount(userId: string, sessionId: string): Promise<number> {
  return sessionDb.transaction("r", sessionDb.drafts, sessionDb.outbox, async () => {
    const drafts = await sessionDb.drafts
      .where("[user_id+session_id]")
      .equals([userId, sessionId])
      .toArray();
    const pending = await sessionDb.outbox.where("user_id").equals(userId).toArray();
    const upserts = new Set(
      pending
        .filter(
          (row) =>
            row.entity === "performed_set" && row.op === "upsert" && row.payload.completed === true,
        )
        .map((row) => row.client_id),
    );
    return drafts.filter((draft) => draft.completed && upserts.has(draft.client_id)).length;
  });
}

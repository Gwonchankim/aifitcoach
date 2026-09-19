import { sessionDb, readWeekSwapEpoch } from "../components/session/session-db";
import { parseSwapRequest, type WeekSwapRequest } from "./week-swap";
const key = (programId: string) => `week-swap-intent:${programId}`;
export async function saveSwapIntent(
  userId: string,
  programId: string,
  request: WeekSwapRequest,
): Promise<void> {
  await sessionDb.transaction("rw", sessionDb.syncMeta, async () => {
    const existing = await sessionDb.syncMeta.get([userId, key(programId)]);
    const serialized = JSON.stringify(request);
    if (existing && existing.value !== serialized) throw new Error("unresolved weekly swap");
    await sessionDb.syncMeta.put({ user_id: userId, key: key(programId), value: serialized });
    await bumpWeekSwapEpoch(userId);
  });
}
export async function readSwapIntent(
  userId: string,
  programId: string,
): Promise<WeekSwapRequest | null> {
  const stored = await sessionDb.syncMeta.get([userId, key(programId)]);
  if (!stored) return null;
  const request = parseSwapRequest(JSON.parse(stored.value));
  if (!request) throw new Error("unrecognized weekly swap intent");
  return request;
}
export async function clearSwapIntent(
  userId: string,
  programId: string,
  clientId: string,
): Promise<void> {
  await sessionDb.transaction("rw", sessionDb.syncMeta, async () => {
    const request = await readSwapIntent(userId, programId);
    if (request?.client_id === clientId) await sessionDb.syncMeta.delete([userId, key(programId)]);
  });
}
export async function hasSwapPending(userId: string, sessionIds: string[] = []): Promise<boolean> {
  if (await sessionDb.outbox.where("user_id").equals(userId).count()) return true;
  // Drafts survive ACKs. Only drafts for the actual swap pair can prohibit that swap;
  // unrelated historic records must not disable all future schedule changes forever.
  const drafts = await sessionDb.drafts.where("user_id").equals(userId).toArray();
  return drafts.some((draft) => sessionIds.includes(draft.session_id));
}
export async function bumpWeekSwapEpoch(userId: string): Promise<void> {
  await sessionDb.transaction("rw", sessionDb.syncMeta, async () => {
    const epoch = await readWeekSwapEpoch(userId);
    await sessionDb.syncMeta.put({
      user_id: userId,
      key: "week-swap-epoch",
      value: String(Number(epoch) + 1),
    });
  });
}

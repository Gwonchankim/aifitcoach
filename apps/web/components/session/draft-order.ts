import type { SetDraft } from "./session-store";

/** The same LWW order for durable and visible drafts during identity remapping. */
export function isNewerDraft(
  candidate: Pick<SetDraft, "updated_at" | "client_id">,
  current: Pick<SetDraft, "updated_at" | "client_id"> | undefined,
): boolean {
  return (
    !current ||
    candidate.updated_at > current.updated_at ||
    (candidate.updated_at === current.updated_at && candidate.client_id > current.client_id)
  );
}

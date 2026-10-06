import { TEST_TODAY_ENV, isoDate } from "../../src/common/date/utc-day";
import type { PrismaService } from "../../src/prisma/prisma.service";

/**
 * Runs one act (a complete/sync call) with the server's UTC today set to `date`, then restores it.
 *
 * BUG-10 Q1 alignment only: tests written before the fact-write window (UTC today + previous day)
 * that complete or edit a session "on its own day" without that date being their subject. Wrap the
 * act, never the assertions, and pass the session's own scheduled_date.
 *
 * The date guard's own tests must NOT use this — they assert older/future rejection directly at the
 * suite's fixed today.
 */
export async function withUtcToday<T>(date: Date | string, act: () => PromiseLike<T>): Promise<T> {
  const previous = process.env[TEST_TODAY_ENV];
  process.env[TEST_TODAY_ENV] = typeof date === "string" ? date : isoDate(date);
  try {
    return await act();
  } finally {
    if (previous === undefined) delete process.env[TEST_TODAY_ENV];
    else process.env[TEST_TODAY_ENV] = previous;
  }
}

/** `withUtcToday` on the stored scheduled_date of `sessionId` (when only the id is at hand). */
export async function onSessionDay<T>(
  prisma: PrismaService,
  sessionId: string,
  act: () => PromiseLike<T>,
): Promise<T> {
  const { scheduledDate } = await prisma.workoutSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { scheduledDate: true },
  });
  return withUtcToday(scheduledDate, act);
}

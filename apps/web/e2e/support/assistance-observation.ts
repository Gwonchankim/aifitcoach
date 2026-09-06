/** Read-only snapshots for explicitly owned Sprint02/03 E2E databases. No setup writes or resets. */
import { createRequire } from "node:module";
import path from "node:path";

type ObservationClient = {
  workoutSession: { findMany(query: unknown): Promise<unknown[]> };
  $disconnect(): Promise<void>;
};

export async function assistanceDatabaseSnapshot(sessionIds: string[]) {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  const userId = process.env.E2E_DEV_USER_ID;
  if (
    !databaseUrl ||
    databaseUrl !== process.env.DATABASE_URL ||
    databaseUrl !== process.env.DIRECT_URL
  )
    throw new Error(
      "Assistance observation requires three identical explicit owned E2E database URLs.",
    );
  const url = new URL(databaseUrl);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !/^\/afc_(?:gen|eval)_s0[23]_[a-zA-Z0-9_]+_e2e$/.test(url.pathname) ||
    !userId ||
    !/^[0-9a-f-]{36}$/i.test(userId) ||
    sessionIds.length === 0
  )
    throw new Error(
      "Assistance observation refuses a database or identity outside the owned Sprint02/03 run.",
    );
  const requireApi = createRequire(path.resolve(process.cwd(), "../api/package.json"));
  const { PrismaClient } = requireApi("@prisma/client") as {
    PrismaClient: new (options: unknown) => ObservationClient;
  };
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const sessions = await db.workoutSession.findMany({
      where: { id: { in: sessionIds }, program: { userId } },
      orderBy: { id: "asc" },
      include: {
        plannedSets: {
          orderBy: { id: "asc" },
          include: { performedSets: { orderBy: { id: "asc" } } },
        },
      },
    });
    if (sessions.length !== sessionIds.length)
      throw new Error("Observation session ownership mismatch.");
    return JSON.parse(JSON.stringify(sessions)) as unknown;
  } finally {
    await db.$disconnect();
  }
}

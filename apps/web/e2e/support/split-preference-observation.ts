import { createRequire } from "node:module";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { assertPositionRun } from "./session-position-observation";

export type SplitSnapshot = {
  requested_preference: "balanced" | "upper_priority" | "lower_priority" | null;
  effective_preference: "balanced" | "upper_priority" | "lower_priority" | null;
  applicable: boolean;
  reason: "unsupported_days" | "four_day_balanced_only" | "legacy_input" | null;
  upper_days: number;
  lower_days: number;
};
export type TemplateSlot = {
  day: string;
  focus: string;
  exercises: Array<Record<string, unknown> & { exercise_id: string; sets: number | null }>;
};
export type ObservedProgram = {
  id: string;
  generationInput: Record<string, unknown> & { split_preference_snapshot: SplitSnapshot };
  template: TemplateSlot[];
  sessions: Array<{
    id: string;
    scheduledDate: string;
    focus: string;
    plannedSets: Array<{
      [key: string]: unknown;
      id: string;
      exerciseId: string;
      orderIndex: number;
      prescriptionKind: string | null;
      exercise: { region: string | null; modality: string | null; movementPattern: string | null };
    }>;
  }>;
};

/** Read-only owned DB evidence. No seeded preference, prepared plan, deletion or clock override. */
export async function splitDatabaseSnapshot(
  request: APIRequestContext,
): Promise<ObservedProgram[]> {
  await assertPositionRun(request);
  const requireApi = createRequire(path.resolve(process.cwd(), "../api/package.json"));
  const { PrismaClient } = requireApi("@prisma/client") as {
    PrismaClient: new (options: unknown) => {
      program: { findMany(query: unknown): Promise<unknown[]> };
      $disconnect(): Promise<void>;
    };
  };
  const db = new PrismaClient({
    datasources: { db: { url: process.env.E2E_DATABASE_URL } },
  });
  try {
    const rows = await db.program.findMany({
      where: { userId: process.env.E2E_DEV_USER_ID },
      orderBy: { id: "asc" },
      select: {
        id: true,
        generationInput: true,
        template: true,
        sessions: {
          orderBy: [{ scheduledDate: "asc" }, { id: "asc" }],
          select: {
            id: true,
            scheduledDate: true,
            focus: true,
            plannedSets: {
              orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
              include: {
                exercise: { select: { region: true, modality: true, movementPattern: true } },
              },
            },
          },
        },
      },
    });
    return JSON.parse(JSON.stringify(rows)) as ObservedProgram[];
  } finally {
    await db.$disconnect();
  }
}

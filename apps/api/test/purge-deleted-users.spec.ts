/** The production purge Job physically removes only accounts deleted before its explicit cutoff. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { REPO_ROOT } from "./support/database-url";
import { testUserId } from "./support/users";

const USER_ID = testUserId("purge");
const prisma = new PrismaClient();

async function removeFixture(): Promise<void> {
  await prisma.accessAudit.deleteMany({ where: { userId: USER_ID } });
  await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
  await prisma.consent.deleteMany({ where: { userId: USER_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

describe("deleted-user purge Job", () => {
  beforeEach(async () => {
    await removeFixture();
    await prisma.user.create({
      data: {
        id: USER_ID,
        sex: "other",
        birthYear: 1995,
        heightCm: 175,
        weightKg: 75,
        goal: "hypertrophy",
        experienceLevel: "intermediate",
        constraints: {},
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await prisma.consent.create({
      data: {
        userId: USER_ID,
        type: "privacy_collection",
        version: "test",
        granted: true,
        grantedAt: new Date(),
      },
    });
    await prisma.authSession.create({
      data: {
        userId: USER_ID,
        sessionTokenHash: createHash("sha256").update(`${USER_ID}:sid`).digest("hex"),
        csrfTokenHash: createHash("sha256").update(`${USER_ID}:csrf`).digest("hex"),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    await prisma.accessAudit.create({
      data: { userId: USER_ID, action: "account_delete_requested" },
    });
  });

  afterAll(async () => {
    await removeFixture();
    await prisma.$disconnect();
  });

  it("requires an explicit cutoff and deletes child records before the soft-deleted account", async () => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "purge-deleted-users.mjs")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DIRECT_URL: process.env.DATABASE_URL,
          PURGE_BEFORE: "2026-02-01T00:00:00.000Z",
        },
        encoding: "utf8",
      },
    );

    if (result.status !== 0) {
      throw new Error(`purge Job 실패\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
    expect(result.stdout).toContain("1건을 영구 삭제했습니다.");
    await expect(prisma.user.findUnique({ where: { id: USER_ID } })).resolves.toBeNull();
    await expect(prisma.authSession.count({ where: { userId: USER_ID } })).resolves.toBe(0);
    await expect(prisma.accessAudit.count({ where: { userId: USER_ID } })).resolves.toBe(0);
    await expect(prisma.consent.count({ where: { userId: USER_ID } })).resolves.toBe(0);
  });
});

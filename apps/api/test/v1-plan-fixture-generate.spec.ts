import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { ProgramsService } from "../src/programs/programs.service";
import type { GenerateProgramDto } from "../src/programs/dto/generate-program.dto";
import { PrismaService } from "../src/prisma/prisma.service";
import { devUserId } from "../src/auth/dev-user";
import { createTestApp, resetUserData } from "./support/app";
import { normalizeProgram, planKey } from "./support/v1-plan-fixture";

/**
 * V1 225조합 정적 fixture **생성기**. 기본적으로 아무것도 하지 않는다.
 *
 * **테스트가 fixture 를 자동 갱신하면 안 된다** — 규칙을 바꿔도 fixture 가 따라 바뀌어
 * 회귀를 영원히 못 잡는다. 그래서 명시적 환경변수가 있을 때만 쓴다:
 *
 *   AFC_WRITE_V1_FIXTURE=1 pnpm --filter api test -- v1-plan-fixture-generate
 *
 * 규칙을 **의도적으로** 바꿨을 때만 사람이 실행하고, 그 diff 를 리뷰에 올린다.
 */

const ENABLED = process.env.AFC_WRITE_V1_FIXTURE === "1";
const OUT = join(__dirname, "fixtures", "v1-plan-225.json");

const GOALS = ["diet", "hypertrophy", "strength"] as const;
const DAYS = [2, 3, 4, 5, 6];
const MINUTES = [30, 45, 60, 75, 90];
const LEVELS = ["beginner", "intermediate", "advanced"] as const;

describe("V1 225조합 fixture 생성기", () => {
  it("생성 모드는 명시적 환경변수로만 켜진다", () => {
    // 평소 테스트 실행에서는 `ENABLED` 가 false 라 아래 생성 케이스가 skip 된다.
    // 이 값이 코드 어딘가에서 자동으로 켜지지 않는다는 것이 계약이다.
    expect(ENABLED).toBe(process.env.AFC_WRITE_V1_FIXTURE === "1");
  });

  (ENABLED ? it : it.skip)(
    "AFC_WRITE_V1_FIXTURE=1 일 때만 225조합을 생성한다",
    async () => {
      let app: INestApplication | undefined;
      try {
        app = await createTestApp();
        const programs = app.get(ProgramsService);
        const prisma = app.get(PrismaService);
        const userId = devUserId();

        const cases = [];
        for (const goal of GOALS) {
          for (const days of DAYS) {
            for (const minutes of MINUTES) {
              for (const level of LEVELS) {
                await resetUserData(prisma, userId);
                const program = await programs.generate(userId, {
                  goal,
                  days_per_week: days,
                  minutes_per_day: minutes,
                  experience_level: level,
                } as GenerateProgramDto);
                cases.push(normalizeProgram(planKey(goal, days, minutes, level), program));
              }
            }
          }
        }

        expect(cases).toHaveLength(225);
        writeFileSync(
          OUT,
          `${JSON.stringify(
            {
              note: "생성: AFC_WRITE_V1_FIXTURE=1 pnpm --filter api test -- v1-plan-fixture-generate. 손으로 고치지 말 것.",
              rules_version: "2026.08.1",
              cases,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } finally {
        await app?.close();
      }
    },
    900_000,
  );
});

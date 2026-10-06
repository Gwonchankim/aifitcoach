/**
 * BUG-10 — 정상 경로 처방 동일성 (위험 기반 matrix).
 *
 * 날짜 창·replay·판정 순간을 바꾼 BUG-10 이 **정상 경로의 다음 처방**(무게·반복·세트 수·사유 …)을
 * 바꾸지 않았음을, 계산 경로가 다른 대표군마다 고정한다. 시나리오는 `support/prescription-matrix.ts`.
 *
 * 기준값 `fixtures/prescription-identity-a74aa81.json` 은 **동일성 기준이지 정답 기준이 아니다**
 * (fixture 의 `intent`). full `a74aa81`(BUG-10 직전 master)에서 그 시나리오 파일을 그대로 실행해
 * 얻었고(`source_sha256`), 같은 base 에서 두 번 캡처해 결정적임을 확인했다. 처방이 틀렸다고 판단되면
 * 엔진·스펙을 고치고, 그 변경의 일부로 base 에서 다시 캡처한다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { MATRIX_CASES, matrixSourceSha256, runMatrixCase } from "./support/prescription-matrix";

const frozen = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/prescription-identity-a74aa81.json"), "utf8"),
) as { capture_commit: string; source_sha256: string; cases: Record<string, unknown> };

describe("BUG-10 — after normal acts the next prescription equals full a74aa81's", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  }, 60_000);
  beforeEach(async () => resetUserData(prisma, devUserId()));
  afterAll(async () => {
    try {
      if (prisma) await resetUserData(prisma, devUserId());
    } finally {
      await app?.close();
    }
  });

  it("the baseline was captured on full a74aa81 from this exact scenario", () => {
    expect(frozen.capture_commit).toBe("a74aa815a8a96486b989cfbc49bf3bca96f30b01");
    // 시나리오가 바뀌면 기준값은 다른 행위의 결과다 — base 에서 다시 캡처해야 한다.
    expect(frozen.source_sha256).toBe(matrixSourceSha256());
    expect(Object.keys(frozen.cases).sort()).toEqual(MATRIX_CASES.map((c) => c.key).sort());
  });

  it.each(MATRIX_CASES.map((matrixCase) => [matrixCase.key, matrixCase] as const))(
    "%s: every act applies, then the next prescription is a74aa81's",
    async (key, matrixCase) => {
      expect(await runMatrixCase(app, matrixCase)).toEqual(frozen.cases[key]);
    },
    30_000,
  );
});

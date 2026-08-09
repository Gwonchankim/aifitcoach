/**
 * **실행 단위** 테스트 사용자 id — 같은 스위트를 동시에 두 번 돌려도 서로를 지우지 않게 한다.
 *
 * 왜 필요한가: 모든 spec 이 고정 `DEV_USER_ID`(…0001)와 고정 보조 id(…0002/0003/0004)를 쓰고,
 * 정리는 `resetUserData(userId)` 로 **그 사용자의 데이터를 전부 지우는** 방식이다.
 * 그래서 두 실행이 겹치면 A 의 정리가 B 의 데이터를 날린다(실측: 동시 실행 시 33·29건 실패).
 * STEP 6(오프라인 동기화)은 "중복·유실 0"을 단언해야 하는데, 테스트끼리 데이터를 지우면 그 단언을 믿을 수 없다.
 *
 * 방식: 실행마다 `AFC_TEST_RUN_ID` 를 하나 만들고(globalSetup), 거기서 용도별 UUID 를 **결정적으로** 파생한다.
 * 결정적이라 워커·teardown 이 같은 값을 다시 계산할 수 있고, 실행이 다르면 값이 겹치지 않는다.
 */
import { createHash } from "node:crypto";

export const RUN_ID_ENV = "AFC_TEST_RUN_ID";

/** teardown 이 지워야 할 사용자 목록. 새 용도를 쓰는 spec 이 생기면 여기에 추가한다. */
export const TEST_USER_SEEDS = ["dev", "tenancy", "dashboard", "adhoc"] as const;
export type TestUserSeed = (typeof TEST_USER_SEEDS)[number];

function runId(): string {
  const id = process.env[RUN_ID_ENV];
  if (!id) {
    throw new Error(
      `${RUN_ID_ENV} 가 없다. jest globalSetup 이 설정해야 한다(test/global-setup.ts).`,
    );
  }
  return id;
}

/** 해시 32자리를 UUID 형식으로 — users.id 가 uuid 컬럼이라 형식이 맞아야 한다(v4 표기). */
function asUuid(hex: string): string {
  const c = hex.slice(0, 32).split("");
  c[12] = "4";
  c[16] = "8";
  const s = c.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export function testUserId(seed: TestUserSeed): string {
  return asUuid(createHash("sha256").update(`${runId()}:${seed}`).digest("hex"));
}

/**
 * 생성 타입 실소비 컴파일 검사 — apps/web/lib/api-types.ts(`pnpm codegen` 생성물)의 paths·components·
 * operations 를 type-only 로 꺼내 대표 operation 의 요청·응답이 계약 schema 와 정확히 같은지 단언한다.
 *
 *   pnpm exec tsc -p scripts/tsconfig.rebuild-api-types.json --noEmit
 *
 * 런타임 코드는 없다(type-only import 뿐). 경로·operation·schema·필드 이름이 사라지거나 바뀌면 인덱스 접근이,
 * 타입이 달라지거나 any 로 무너지면 Expect 가 컴파일 오류가 된다. apps/api 의 typecheck 에도 포함된다.
 */
import type { components, operations, paths } from "../apps/web/lib/api-types";

type Schemas = components["schemas"];
type Json<T> = T extends { content: { "application/json": infer Body } } ? Body : never;
/** A·B 가 정확히 같은 타입일 때만 true — any 는 any 가 아닌 어떤 타입과도 같지 않다. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Expect<T extends true> = T;

type GenerateProgram = paths["/programs/generate"]["post"];
type Sync = paths["/sync"]["post"];
type Dashboard = paths["/dashboard"]["get"];
type AppendSet = paths["/sessions/{id}/sets"]["post"];

export type RebuildApiTypeChecks = [
  // 프로그램 생성: CSRF 헤더 + 요청 본문 + 201 응답
  Expect<
    Equal<
      GenerateProgram["parameters"]["header"]["X-CSRF-Token"],
      components["parameters"]["CsrfHeader"]
    >
  >,
  Expect<Equal<Json<GenerateProgram["requestBody"]>, Schemas["GenerateProgramRequest"]>>,
  Expect<Equal<Json<GenerateProgram["responses"][201]>, Schemas["Program"]>>,
  Expect<Equal<Schemas["GenerateProgramRequest"]["minutes_per_day"], 30 | 45 | 60 | 75 | 90>>,
  Expect<Equal<Schemas["Program"]["program_id"], string>>,
  // 오프라인 동기화: 배치 push 요청 + 200 응답
  Expect<Equal<Json<Sync["requestBody"]>, Schemas["SyncRequest"]>>,
  Expect<Equal<Json<Sync["responses"][200]>, Schemas["SyncResponse"]>>,
  Expect<Equal<Schemas["SyncRequest"]["mutations"], Schemas["Mutation"][]>>,
  Expect<Equal<Schemas["SyncResponse"]["applied"], string[]>>,
  // 대시보드 조회
  Expect<Equal<Json<Dashboard["responses"][200]>, Schemas["DashboardSummary"]>>,
  Expect<Equal<Schemas["DashboardSummary"]["tomorrow"]["status"], "workout" | "rest">>,
  // 세트 추가: operations 참조·경로 매개변수·요청·201 응답
  Expect<Equal<AppendSet, operations["appendSessionSet"]>>,
  Expect<Equal<AppendSet["parameters"]["path"], { id: string }>>,
  Expect<Equal<Json<AppendSet["requestBody"]>, Schemas["AppendSetRequest"]>>,
  Expect<Equal<Json<AppendSet["responses"][201]>, Schemas["AppendSetResult"]>>,
  // 소비한 schema 가 any 로 무너지지 않았다
  Expect<Equal<IsAny<Schemas["GenerateProgramRequest"]>, false>>,
  Expect<Equal<IsAny<Schemas["Program"]>, false>>,
  Expect<Equal<IsAny<Schemas["SyncRequest"]>, false>>,
  Expect<Equal<IsAny<Schemas["DashboardSummary"]>, false>>,
  Expect<Equal<IsAny<Schemas["AppendSetResult"]>, false>>,
];

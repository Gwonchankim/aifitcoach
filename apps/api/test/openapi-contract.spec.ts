/**
 * 계약 완전성 테스트: docs/specs/openapi.yaml 의 모든 path × method 가
 * 실제 Nest(express) 라우터에 등록되어 있는지 양방향으로 대조한다.
 *   - 누락: openapi 에 있는데 라우트가 없음
 *   - 초과: 라우트가 있는데 openapi 에 없음(임의 엔드포인트 금지)
 * 경로 목록을 코드에 복사하지 않고 yaml 에서 동적으로 읽는다.
 */
import "reflect-metadata";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { parse } from "yaml";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";

const OPENAPI_PATH = path.resolve(__dirname, "..", "..", "..", "docs", "specs", "openapi.yaml");
const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

type OpenApiDoc = {
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components?: { responses?: Record<string, ResponseNode> };
};

type ResponseNode = {
  $ref?: string;
  content?: { "application/json"?: { schema?: { $ref?: string } } };
};

type ExpressLayer = { route?: { path: string | string[]; methods: Record<string, boolean> } };

/** openapi `{id}` 와 nest `:id` 의 표기 차이를 `{id}` 로 통일한다. */
function canonical(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`;
}

function loadDoc(): OpenApiDoc {
  return parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDoc;
}

/** servers[].url 의 basePath(/v1)를 붙여 실제 요청 경로 기준으로 만든다. */
function contractOperations(doc: OpenApiDoc): string[] {
  const basePath = new URL(doc.servers[0].url).pathname.replace(/\/$/, "");
  return Object.entries(doc.paths)
    .flatMap(([routePath, operations]) =>
      Object.keys(operations)
        .filter((method) => HTTP_METHODS.includes(method))
        .map((method) => canonical(method, `${basePath}${routePath}`)),
    )
    .sort();
}

/** 선언된 에러 응답(4xx/5xx)을 `METHOD path status` → 바디 스키마 $ref 로 펼친다(components 참조 해소). */
function errorResponseSchemas(doc: OpenApiDoc): Record<string, string | undefined> {
  const named = doc.components?.responses ?? {};
  const result: Record<string, string | undefined> = {};
  for (const [routePath, operations] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const responses = (operation as { responses?: Record<string, ResponseNode> }).responses ?? {};
      for (const [status, declared] of Object.entries(responses)) {
        if (!/^[45]\d\d$/.test(status)) continue;
        const ref = declared.$ref;
        const node = ref ? named[ref.replace("#/components/responses/", "")] : declared;
        result[`${canonical(method, routePath)} ${status}`] =
          node?.content?.["application/json"]?.schema?.$ref;
      }
    }
  }
  return result;
}

function registeredOperations(app: INestApplication): string[] {
  const instance = app.getHttpAdapter().getInstance() as { router?: { stack: ExpressLayer[] } };
  const stack = instance.router?.stack;
  if (!stack) throw new Error("express 라우터 스택을 찾지 못했다(express 버전 변경?).");

  return stack
    .flatMap((layer) => {
      const route = layer.route;
      if (!route) return [];
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      return paths.flatMap((routePath) =>
        Object.keys(route.methods)
          .filter((method) => method !== "_all")
          .map((method) => canonical(method, routePath)),
      );
    })
    .sort();
}

describe("openapi 계약 ↔ 등록된 라우트", () => {
  let app: INestApplication;
  let contract: string[];
  let registered: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    contract = contractOperations(loadDoc());
    registered = registeredOperations(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("openapi 에 operation 이 하나 이상 있다(로딩 자체 검증)", () => {
    expect(contract.length).toBeGreaterThan(0);
    expect(registered.length).toBeGreaterThan(0);
  });

  it("누락 없음: openapi 의 모든 path×method 가 라우터에 등록돼 있다", () => {
    const missing = contract.filter((operation) => !registered.includes(operation));
    expect(missing).toEqual([]);
  });

  it("초과 없음: openapi 에 없는 라우트가 등록돼 있지 않다", () => {
    const extra = registered.filter((operation) => !contract.includes(operation));
    expect(extra).toEqual([]);
  });

  it("operation 수가 openapi 와 정확히 일치한다", () => {
    expect(registered).toEqual(contract);
  });

  /**
   * 상태코드 축의 계약 일관성: 에러 응답의 바디는 하나의 Error 엔벨로프여야 한다
   * (프론트가 상태코드별로 다른 파싱을 하지 않도록). 바디가 없는 선언은 검사 대상이 아니다.
   */
  it("선언된 4xx/5xx 응답의 바디는 모두 Error 스키마다", () => {
    const schemas = errorResponseSchemas(loadDoc());
    const wrong = Object.entries(schemas).filter(
      ([, ref]) => ref !== undefined && ref !== "#/components/schemas/Error",
    );

    expect(Object.keys(schemas).length).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });
});

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
});

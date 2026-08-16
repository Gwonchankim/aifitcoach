/**
 * 응답 ↔ openapi 스키마 검증기 (STEP 2 I-1 / STEP 4 DoD).
 *
 * docs/specs/openapi.yaml 을 **동적으로 로드**해 `paths.<path>.<method>.responses.<status>` 의
 * 스키마로 실제 응답 바디를 검증한다. 기대값을 테스트 코드에 복사하지 않는다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";

const OPENAPI_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "specs",
  "openapi.yaml",
);
const SCHEMA_KEY = "openapi";

/** OpenAPI 3.0 의 `nullable: true` 를 JSON Schema 의 union 타입으로 옮긴다. */
function toJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (node === null || typeof node !== "object") return node;

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "nullable") continue;
    result[key] = toJsonSchema(value);
  }
  if (source.nullable === true && typeof source.type === "string") {
    result.type = [source.type, "null"];
  } else if (source.nullable === true) {
    return { anyOf: [result, { type: "null" }] };
  }
  return result;
}

let ajv: Ajv | undefined;
let document: Record<string, unknown> | undefined;

function openapiDocument(): Record<string, unknown> {
  document ??= toJsonSchema(parse(readFileSync(OPENAPI_PATH, "utf8"))) as Record<string, unknown>;
  return document;
}

function instance(): Ajv {
  if (!ajv) {
    const created = new Ajv({ strict: false, validateSchema: false, allErrors: true });
    addFormats(created);
    created.addSchema(openapiDocument(), SCHEMA_KEY);
    ajv = created;
  }
  return ajv;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

type SchemaNode = Record<string, unknown>;

/** `#/components/schemas/X` 만 쓰는 계약이라 로컬 포인터만 따라간다. */
function resolveRef(schema: SchemaNode): SchemaNode {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  let node: unknown = openapiDocument();
  for (const segment of ref.replace(/^#\//, "").split("/")) {
    node = (node as Record<string, unknown>)[unescapePointer(segment)];
  }
  return resolveRef(node as SchemaNode);
}

/**
 * openapi 에 선언되지 않은 키를 모은다.
 * 계약에 additionalProperties:false 가 없어서 ajv 는 여분 필드를 통과시킨다 →
 * 응답에 user_id·평문 pain 같은 값이 새어도 스키마 게이트가 못 잡는다(STEP 4 평가 PIPA 결함).
 * 스키마가 additionalProperties 를 명시적으로 허용한 자리(Mutation.payload 등)는 건너뛴다.
 */
function collectUndeclaredKeys(
  schema: SchemaNode,
  value: unknown,
  pointer: string,
  found: string[],
): void {
  const node = resolveRef(schema);
  const allOf = node.allOf as SchemaNode[] | undefined;
  if (allOf) {
    for (const branch of allOf) collectUndeclaredKeys(branch, value, pointer, found);
    return;
  }
  const anyOf = node.anyOf as SchemaNode[] | undefined;
  if (anyOf) {
    for (const branch of anyOf) {
      if (branch.type !== "null") collectUndeclaredKeys(branch, value, pointer, found);
    }
    return;
  }

  if (Array.isArray(value)) {
    const items = node.items as SchemaNode | undefined;
    if (items) {
      value.forEach((item, index) =>
        collectUndeclaredKeys(items, item, `${pointer}[${index}]`, found),
      );
    }
    return;
  }
  if (value === null || typeof value !== "object") return;

  const properties = node.properties as Record<string, SchemaNode> | undefined;
  if (!properties || node.additionalProperties) return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const declared = properties[key];
    if (!declared) {
      found.push(`${pointer}.${key}`);
      continue;
    }
    collectUndeclaredKeys(declared, child, `${pointer}.${key}`, found);
  }
}

function nodeAt(segments: string[]): unknown {
  let node: unknown = openapiDocument();
  for (const segment of segments) {
    node = (node as Record<string, unknown> | undefined)?.[segment];
  }
  return node;
}

/**
 * 응답 노드까지의 경로. 에러 응답은 `$ref: '#/components/responses/NotFound'` 처럼
 * 공용 응답을 가리키므로 그 자리를 먼저 푼다.
 */
function responseSegments(method: string, contractPath: string, status: number): string[] {
  const declared = ["paths", contractPath, method.toLowerCase(), "responses", String(status)];
  const ref = (nodeAt(declared) as SchemaNode | undefined)?.$ref;
  if (typeof ref !== "string") return declared;
  return ref.replace(/^#\//, "").split("/").map(unescapePointer);
}

function schemaSegments(method: string, contractPath: string, status: number): string[] {
  return [
    ...responseSegments(method, contractPath, status),
    "content",
    "application/json",
    "schema",
  ];
}

/** openapi 의 응답 스키마 검증 함수. path 는 계약 표기(`/sessions/{sessionId}`) 그대로 넘긴다. */
export function responseValidator(
  method: string,
  contractPath: string,
  status: number,
): ValidateFunction {
  const pointer = schemaSegments(method, contractPath, status).map(escapePointer).join("/");

  const validate = instance().getSchema(`${SCHEMA_KEY}#/${pointer}`);
  if (!validate) {
    throw new Error(`openapi 에 응답 스키마가 없다: ${method} ${contractPath} ${status}`);
  }
  return validate;
}

/** 응답 스키마 노드 자체(키셋 검사용). responseValidator 와 같은 위치를 가리킨다. */
function responseSchema(method: string, contractPath: string, status: number): SchemaNode {
  const node = nodeAt(schemaSegments(method, contractPath, status));
  if (!node) {
    throw new Error(`openapi 에 응답 스키마가 없다: ${method} ${contractPath} ${status}`);
  }
  return node as SchemaNode;
}

/**
 * 응답 바디가 openapi 계약을 만족하는지 단언한다(위반 시 어떤 필드가 왜 틀렸는지 출력).
 * required/타입(ajv)뿐 아니라 **선언되지 않은 키가 없는지**(키셋)도 함께 본다.
 */
export function expectMatchesContract(
  method: string,
  contractPath: string,
  status: number,
  body: unknown,
): void {
  const validate = responseValidator(method, contractPath, status);
  if (!validate(body)) {
    throw new Error(
      `${method} ${contractPath} ${status} 응답이 openapi 스키마를 위반한다:\n` +
        JSON.stringify(validate.errors, null, 2),
    );
  }

  const undeclared: string[] = [];
  collectUndeclaredKeys(responseSchema(method, contractPath, status), body, "$", undeclared);
  if (undeclared.length > 0) {
    throw new Error(
      `${method} ${contractPath} ${status} 응답에 openapi 에 없는 키가 있다: ${undeclared.join(", ")}`,
    );
  }
}

/**
 * 에러 응답의 **상태코드 축** 계약 검사.
 * 1) 구현이 낸 상태코드가 기대와 같은지 → 구현이 409 대신 400 을 내면 여기서 깨진다.
 * 2) 그 상태코드가 openapi 에 선언돼 있는지 → 없으면 스키마 조회에서 즉시 실패한다.
 * 3) 바디가 그 자리의 스키마(Error 엔벨로프)를 만족하는지.
 */
export function expectErrorMatchesContract(
  method: string,
  contractPath: string,
  status: number,
  response: { status: number; body: unknown },
): void {
  if (response.status !== status) {
    throw new Error(
      `${method} ${contractPath}: 상태코드가 ${status} 여야 하는데 ${response.status} 다. ` +
        `바디: ${JSON.stringify(response.body)}`,
    );
  }
  expectMatchesContract(method, contractPath, status, response.body);
}

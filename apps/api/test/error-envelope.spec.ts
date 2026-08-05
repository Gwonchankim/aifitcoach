/**
 * ErrorEnvelopeFilter 단위 테스트.
 * HttpException 이 아닌 예외(코드 버그·드라이버 오류)도 openapi 의 Error 엔벨로프로 나가야 하고,
 * 내부 메시지·스택은 응답에 새면 안 된다(SECURITY_PIPA.md — 오류 응답에 내부 정보 미노출).
 */
import "reflect-metadata";
import { ArgumentsHost, ConflictException, Logger, NotFoundException } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import { ErrorEnvelopeFilter } from "../src/common/http/error-envelope.filter";

interface Replied {
  body: unknown;
  status: number;
}

function runFilter(exception: unknown): Replied {
  const replied: Replied[] = [];
  const adapterHost = {
    httpAdapter: {
      reply: (_res: unknown, body: unknown, status: number) => {
        replied.push({ body, status });
      },
    },
  } as unknown as HttpAdapterHost;
  const host = {
    switchToHttp: () => ({ getResponse: () => ({}) }),
  } as unknown as ArgumentsHost;

  new ErrorEnvelopeFilter(adapterHost).catch(exception, host);
  expect(replied).toHaveLength(1);
  return replied[0];
}

describe("ErrorEnvelopeFilter", () => {
  let logged: jest.SpyInstance;

  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logged.mockRestore();
  });

  it("HttpException 은 상태코드 + 코드 매핑 + 원 메시지로 나간다", () => {
    expect(runFilter(new NotFoundException("세션을 찾을 수 없다."))).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "세션을 찾을 수 없다." } },
    });
    expect(runFilter(new ConflictException("이미 완료한 세션이다.")).body).toEqual({
      error: { code: "CONFLICT", message: "이미 완료한 세션이다." },
    });
  });

  it("HttpException 이 아니면 500 + INTERNAL_ERROR 엔벨로프", () => {
    const { status, body } = runFilter(new Error("connect ECONNREFUSED 10.0.0.7:5432"));

    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL_ERROR", message: expect.any(String) } });
  });

  it("내부 예외 메시지·스택은 응답에 노출하지 않고 서버 로그로만 남긴다", () => {
    const secret = "password=hunter2 at /srv/app/src/db.ts:42";

    const { body } = runFilter(new Error(secret));

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("db.ts");
    expect(serialized).not.toContain("stack");
    expect(logged).toHaveBeenCalled();
  });

  it("문자열·객체 등 Error 가 아닌 throw 도 같은 엔벨로프로 나간다", () => {
    expect(runFilter("boom")).toEqual({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: expect.any(String) } },
    });
  });
});

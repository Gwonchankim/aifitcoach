/**
 * M0-04 재작성 기반의 관측 시험.
 *
 * 1) 실제 AppModule 이 등록한 전역 pipe·filter 를 HTTP 로 통과시켜 입력 계약(추가 필드 제거·DTO 변환)과
 *    오류 엔벨로프를 본다. **시험 안에서 ValidationPipe 를 새로 만들지 않는다** — 자기 pipe 를 쓰는 시험은
 *    AppModule 의 옵션이나 provider 가 빠져도 통과한다(session-set-dto.spec 이 그렇다).
 * 2) 시드의 load_semantics helper(prisma/seed-load-semantics.ts)를 직접 호출해 본다.
 * 3) 테스트 날짜 오버라이드가 달력에 없는 날짜를 조용히 넘기지 않는지 본다.
 *
 * AppModule 은 Prisma 연결·dev-user 프로비저닝을 하므로 jest globalSetup 의 test DB 가 필요하다.
 */
import "reflect-metadata";
import { Body, Controller, HttpCode, Logger, Module, Post } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Type } from "class-transformer";
import { IsInt, IsString, Min } from "class-validator";
import request from "supertest";
import { loadSemanticsFor } from "../prisma/seed-load-semantics";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { TEST_TODAY_ENV, testTodayOverride } from "../src/common/date/utc-day";
import { FeatureConflictException } from "../src/common/http/feature-conflict";

/** 시험 전용 DTO — 문자열 하나와 @Type 변환이 필요한 정수 하나. */
class ProbeSetDto {
  @IsString()
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  reps!: number;
}

/** 시험 전용 경계. 핸들러가 실제로 받은 값을 관측값으로 돌려준다(앱 코드에는 없다). */
@Controller("rebuild-foundation-probe")
class ProbeController {
  @Post("echo")
  @HttpCode(200)
  echo(@Body() body: ProbeSetDto) {
    return {
      isDto: body instanceof ProbeSetDto,
      keys: Object.keys(body).sort(),
      repsType: typeof body.reps,
      reps: body.reps,
    };
  }

  @Post("internal")
  internal(): never {
    throw new Error("connect ECONNREFUSED 10.0.0.7:5432 password=hunter2 at /srv/app/src/db.ts:42");
  }

  @Post("conflict")
  conflict(): never {
    throw new FeatureConflictException("cardio_preservation_failed");
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const PROBE = "/v1/rebuild-foundation-probe";

describe("AppModule 전역 pipe·filter 를 거친 HTTP 경계", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ProbeModule],
    }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("DTO 에 선언되지 않은 필드는 400 으로 거부하지 않고 제거한다(whitelist, forbid 없음)", async () => {
    const response = await request(app.getHttpServer())
      .post(`${PROBE}/echo`)
      .send({ name: "bench", reps: 8, extra: "dropped", nested: { raw: 1 } })
      .expect(200);

    expect(response.body.keys).toEqual(["name", "reps"]);
  });

  it("핸들러는 @Type 변환을 거친 DTO 클래스 인스턴스를 받는다(transform)", async () => {
    const response = await request(app.getHttpServer())
      .post(`${PROBE}/echo`)
      .send({ name: "bench", reps: "8" })
      .expect(200);

    expect(response.body).toEqual({
      isDto: true,
      keys: ["name", "reps"],
      repsType: "number",
      reps: 8,
    });
  });

  it("검증에 실패한 입력은 실제 filter 를 거쳐 400 VALIDATION_ERROR 엔벨로프가 된다", async () => {
    const response = await request(app.getHttpServer())
      .post(`${PROBE}/echo`)
      .send({ name: "bench", reps: "zero" })
      .expect(400);

    expect(response.body).toEqual({
      error: { code: "VALIDATION_ERROR", message: expect.stringContaining("reps") },
    });
  });

  it("HttpException 이 아닌 오류는 500 고정 문구로 나가고 내부 메시지는 응답에 없다", async () => {
    const logged = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const response = await request(app.getHttpServer()).post(`${PROBE}/internal`).expect(500);

      expect(response.body).toEqual({
        error: { code: "INTERNAL_ERROR", message: "서버 내부 오류가 발생했다." },
      });
      for (const secret of ["hunter2", "10.0.0.7", "db.ts", "ECONNREFUSED", "stack"]) {
        expect(response.text).not.toContain(secret);
      }
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("타입이 정해진 409 conflict 는 허용된 reason 만 details 로 싣는다", async () => {
    const response = await request(app.getHttpServer()).post(`${PROBE}/conflict`).expect(409);

    expect(response.body).toEqual({
      error: {
        code: "CONFLICT",
        message: "유산소 처방을 안전하게 보존할 수 없습니다.",
        details: { reason: "cardio_preservation_failed" },
      },
    });
  });
});

describe("시드 load_semantics helper(prisma/seed-load-semantics.ts)", () => {
  it.each(["e_assisted_pullup", "e_assisted_dips"])("어시스트 종목 %s 는 assistance", (id) => {
    expect(loadSemanticsFor(id)).toBe("assistance");
  });

  it.each(["e_bench_press", "e_pullup", "e_dips", "e_assisted_row", "E_ASSISTED_PULLUP", ""])(
    "목록 밖·모르는 ID %p 는 external_load(정확 일치만 assistance)",
    (id) => {
      expect(loadSemanticsFor(id)).toBe("external_load");
    },
  );
});

describe("테스트 날짜 오버라이드의 달력 검증(utc-day)", () => {
  const original = process.env[TEST_TODAY_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[TEST_TODAY_ENV];
    else process.env[TEST_TODAY_ENV] = original;
  });

  it.each(["2026-02-30", "2026-04-31", "2027-02-29", "2026-00-10", "2026-13-01"])(
    "달력에 없는 날짜 %s 는 다음 달로 넘기지 않고 던진다",
    (bad) => {
      process.env[TEST_TODAY_ENV] = bad;
      expect(() => testTodayOverride()).toThrow(
        `${TEST_TODAY_ENV} 가 유효한 날짜가 아니다: ${bad}`,
      );
    },
  );

  it.each(["2028-02-29", "2026-08-14", "2026-12-31"])(
    "실제 날짜 %s 는 그날 UTC 자정이다",
    (day) => {
      process.env[TEST_TODAY_ENV] = day;
      expect(testTodayOverride()?.toISOString()).toBe(`${day}T00:00:00.000Z`);
    },
  );
});

/**
 * 통합 테스트(실제 postgres): POST /v1/programs/generate, GET /v1/programs/current.
 * 모든 응답은 openapi 스키마(ajv)로 검증한다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import request from "supertest";
import { parse } from "yaml";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { PAIN_AREAS } from "../src/programs/program-rules";
import { DIFFICULTY_RANK } from "../src/programs/programs.service";
import { createTestApp, resetUserData } from "./support/app";
import { expectErrorMatchesContract, expectMatchesContract } from "./support/openapi-response";

const DOCS = path.resolve(__dirname, "..", "..", "..", "docs");
const OPENAPI_PATH = path.join(DOCS, "specs", "openapi.yaml");
const SAFETY_MAPPING_PATH = path.join(DOCS, "SAFETY_PAIN_MAPPING.md");

const USER_ID = devUserId();
const BASE = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;

describe("programs", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
  });

  async function materializeCurrent(): Promise<void> {
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
  }

  it("프로그램이 없으면 GET /programs/current → 404 + 에러 엔벨로프", async () => {
    const response = await request(app.getHttpServer()).get("/v1/programs/current");

    expectErrorMatchesContract("get", "/programs/current", 404, response);
    expect(response.body).toEqual({ error: { code: "NOT_FOUND", message: expect.any(String) } });
  });

  it("POST /programs/generate → 201 + openapi Program 스키마", async () => {
    const response = await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE);

    expect(response.status).toBe(201);
    expectMatchesContract("post", "/programs/generate", 201, response.body);
    expect(response.body.split_type).toBe("upper_lower");
    expect(response.body.goal).toBe("hypertrophy");
    expect(response.body.rules_version).toBe("2026.08.1");
    expect(response.body).toMatchObject({
      total_weeks: 12,
      current_week: 1,
      status: "active",
      started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(response.body.sessions).toHaveLength(4);
    expect(response.body.sessions.map((s: { day: string }) => s.day)).toEqual([
      "MON",
      "TUE",
      "THU",
      "FRI",
    ]);
    expect(response.body.sessions.map((s: { focus: string }) => s.focus)).toEqual([
      "upper",
      "lower",
      "upper",
      "lower",
    ]);
    // minutes_per_day 60 → 하루 5종목
    for (const session of response.body.sessions) {
      expect(session.exercises).toHaveLength(5);
    }
  });

  it("POST는 lifecycle만 저장하고 첫 read가 현재+다음 주 세션만 lazy materialize한다", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE).expect(201);

    const programs = await prisma.program.findMany({ where: { userId: USER_ID } });
    expect(programs).toHaveLength(1);
    expect(programs[0]).toMatchObject({ totalWeeks: 12, status: "active" });
    expect(programs[0].generationInput).toEqual({
      ...BASE,
      equipment: [],
      avoid_exercises: [],
      pain_areas: [],
    });
    expect(await prisma.workoutSession.count({ where: { programId: programs[0].id } })).toBe(0);

    await materializeCurrent();

    // lazy window는 현재+다음 주뿐이다. 12주(48개)를 미리 만들지 않는다.
    const sessions = await prisma.workoutSession.findMany({
      where: { programId: programs[0].id },
      orderBy: { scheduledDate: "asc" },
      include: { plannedSets: true },
    });
    expect(sessions).toHaveLength(8);
    for (const session of sessions) {
      expect(session.plannedSets).toHaveLength(15);
      expect(session.status).toBe("scheduled");
    }

    // day 표기와 실제 scheduled_date 의 요일이 일치한다(MON=1 … SUN=0)
    expect(sessions.map((s) => s.scheduledDate.getUTCDay())).toEqual([1, 2, 4, 5, 1, 2, 4, 5]);

    // 다른 사용자 소유 데이터는 만들어지지 않는다.
    // **DB 전체를 세지 않는다** — 그러면 같은 스위트를 동시에 돌리는 다른 실행의 데이터까지 세어
    // 원리적으로 통과할 수 없다(실측: 동시 실행에서 이 단언만 실패했다).
    // 검증 대상은 "이 요청이 만든 것"이므로 방금 만든 프로그램의 소유자와 그 자식들만 본다.
    // 사용자 간 격리 자체는 tenancy.spec.ts 가 두 사용자를 세워 따로 검증한다.
    expect(programs[0].userId).toBe(USER_ID);
    const foreignChildren = await prisma.plannedSet.count({
      where: { session: { program: { id: programs[0].id, userId: { not: USER_ID } } } },
    });
    expect(foreignChildren).toBe(0);
  });

  it("generation_input이 없는 레거시도 저장된 template만으로 lazy materialize한다", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE).expect(201);
    const program = await prisma.program.findFirstOrThrow({ where: { userId: USER_ID } });
    await prisma.program.update({
      where: { id: program.id },
      data: { generationInput: Prisma.JsonNull },
    });

    const response = await request(app.getHttpServer()).get("/v1/programs/current").expect(200);

    expect(response.body.started_at).toBe(program.startedAt.toISOString().slice(0, 10));
    expect(await prisma.workoutSession.count({ where: { programId: program.id } })).toBe(8);
  });

  it("기록이 없으면 계획세트의 추천은 엔진의 BASELINE(weight 0) 을 그대로 저장한다", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE).expect(201);
    await materializeCurrent();

    const plannedSets = await prisma.plannedSet.findMany({
      where: { session: { program: { userId: USER_ID } }, loadSemantics: "external_load" },
    });
    expect(plannedSets.length).toBeGreaterThan(0);
    for (const set of plannedSets) {
      expect(set.reasonCode).toBe("BASELINE");
      expect(Number(set.recommendedWeight)).toBe(0);
      expect(set.recommendedReps).toBe(set.targetRepsLow);
      expect(set.rulesVersion).toBe("2026.08.1");
    }
  });

  /**
   * 어시스트 행은 위 계약을 **일부러** 따르지 않는다 — `2026.08.1` 엔진은 도움 kg 의 의미를
   * 몰라서 BASELINE 0kg 을 "0kg 부하"로 쓰는데, 어시스트에서 그건 도움 0(= 맨몸 풀업)이다.
   * 실제 mapper 는 F-4a 가 소유하고, 그전까지는 무게 미정 fail-safe 다(F-3 fixup).
   */
  it("어시스트 계획세트만 fail-safe(.08.2 · 무게 미정)로 갈라진다", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE).expect(201);
    await materializeCurrent();

    const assisted = await prisma.plannedSet.findMany({
      where: { session: { program: { userId: USER_ID } }, loadSemantics: "assistance" },
    });
    expect(assisted.length).toBeGreaterThan(0);
    for (const set of assisted) {
      expect(set.reasonCode).toBe("ASSISTANCE_CALIBRATION_NEEDED");
      expect(set.recommendedWeight).toBeNull();
      expect(set.rulesVersion).toBe("2026.08.2");
      expect(set.assistanceProvenance).toBe("native");
    }
  });

  it("goal 에 따라 목표 반복·RIR·휴식이 문서 표대로 정해진다", async () => {
    await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({ ...BASE, goal: "strength" })
      .expect(201);
    await materializeCurrent();

    const compound = await prisma.plannedSet.findFirstOrThrow({
      where: { session: { program: { userId: USER_ID } }, exercise: { mechanic: "compound" } },
    });
    expect(compound.targetRepsLow).toBe(3);
    expect(compound.targetRepsHigh).toBe(5);
    expect(compound.targetRir).toBe(3);
    expect(compound.restSec).toBe(180);
  });

  it("avoid_exercises 는 제외되고 equipment 는 필터로 쓰인다", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({ ...BASE, equipment: ["barbell", "dumbbell"], avoid_exercises: ["e_bench_press"] })
      .expect(201);

    const exerciseIds: string[] = response.body.sessions.flatMap(
      (session: { exercises: { exercise_id: string }[] }) =>
        session.exercises.map((exercise) => exercise.exercise_id),
    );
    expect(exerciseIds).not.toContain("e_bench_press");
    expect(exerciseIds.length).toBeGreaterThan(0);

    const used = await prisma.exercise.findMany({ where: { id: { in: exerciseIds } } });
    for (const exercise of used) {
      expect(["barbell", "dumbbell"]).toContain(exercise.equipment);
    }
  });

  /**
   * 한 세션에 같은 종목이 두 번 배정되면 F5 편집이 깨진다(plannedExerciseId = exercise_id 라
   * 하나를 지우면 둘 다 지워진다). push/pull 은 패턴 목록이 반복되므로 여기서 걸린다.
   */
  it("한 세션에 같은 exercise_id 를 두 번 배정하지 않는다", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({ ...BASE, days_per_week: 6, minutes_per_day: 90 })
      .expect(201);

    for (const session of response.body.sessions) {
      const ids = session.exercises.map(
        (exercise: { exercise_id: string }) => exercise.exercise_id,
      );
      expect(new Set(ids).size).toBe(ids.length);
    }
    // push 는 패턴 7칸 중 3칸이 반복(horizontal_push/vertical_push/elbow_extension)이다 →
    // 중복 방지가 있으면 같은 패턴의 다음 후보로 채워 7종목이 나온다.
    const push = response.body.sessions.find((s: { focus: string }) => s.focus === "push");
    expect(push.exercises).toHaveLength(7);
    await materializeCurrent();

    const sessions = await prisma.workoutSession.findMany({
      where: { program: { userId: USER_ID } },
      include: { plannedSets: true },
    });
    expect(sessions).toHaveLength(12);
    for (const session of sessions) {
      const byExercise = new Set(session.plannedSets.map((set) => set.exerciseId));
      const byOrder = new Set(session.plannedSets.map((set) => set.orderIndex));
      expect(byExercise.size).toBe(byOrder.size);
    }
  });

  /** ez_bar 는 카탈로그에 e_barbell_curl(상체) 하나뿐이라 하체(lower) focus 가 통째로 빈다. */
  it("조건에 맞는 운동이 없으면 400 (openapi 의 BadRequest)", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({ ...BASE, equipment: ["ez_bar"] });

    expectErrorMatchesContract("post", "/programs/generate", 400, response);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("운동 카탈로그가 비었으면 사용자가 고칠 수 없는 503 이다", async () => {
    const findMany = jest.spyOn(prisma.exercise, "findMany").mockResolvedValueOnce([]);
    try {
      const response = await request(app.getHttpServer())
        .post("/v1/programs/generate")
        .send({ ...BASE, equipment: ["barbell", "dumbbell", "machine", "cable", "ez_bar"] });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: { code: "SERVICE_UNAVAILABLE", message: expect.any(String) },
      });
    } finally {
      findMany.mockRestore();
    }
  });

  /**
   * 맨몸(step_kg 없음)·시간(metric=time) 종목도 엔진이 처방할 수 있다 →
   * equipment 가 bodyweight 뿐이어도 프로그램이 나와야 한다(400 금지).
   */
  describe("맨몸(자체중량)·시간 종목", () => {
    async function controlledBodyweightProgram() {
      const keep = new Set(["e_dips", "e_plank"]);
      const avoid_exercises = (
        await prisma.exercise.findMany({
          where: { equipment: "bodyweight" },
          select: { id: true },
        })
      )
        .map((exercise) => exercise.id)
        .filter((id) => !keep.has(id));
      return { ...BASE, equipment: ["bodyweight"], avoid_exercises };
    }

    it("equipment=[bodyweight] 만으로도 프로그램이 생성된다", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/programs/generate")
        .send({ ...BASE, equipment: ["bodyweight"] })
        .expect(201);

      expectMatchesContract("post", "/programs/generate", 201, response.body);
      const exerciseIds: string[] = response.body.sessions.flatMap(
        (session: { exercises: { exercise_id: string }[] }) =>
          session.exercises.map((exercise) => exercise.exercise_id),
      );
      expect(exerciseIds.length).toBeGreaterThan(0);
      const exercises = await prisma.exercise.findMany({ where: { id: { in: exerciseIds } } });
      expect(exercises).toHaveLength(new Set(exerciseIds).size);
      expect(exercises.every((exercise) => exercise.equipment === "bodyweight")).toBe(true);
      expect(
        exercises.every(
          (exercise) => DIFFICULTY_RANK[exercise.difficulty] <= DIFFICULTY_RANK.intermediate,
        ),
      ).toBe(true);
    });

    it("맨몸 종목의 계획세트는 recommended_weight 가 null 이다(0 이 아니다)", async () => {
      await request(app.getHttpServer())
        .post("/v1/programs/generate")
        .send(await controlledBodyweightProgram())
        .expect(201);
      await materializeCurrent();

      const dips = await prisma.plannedSet.findMany({
        where: { session: { program: { userId: USER_ID } }, exerciseId: "e_dips" },
      });
      expect(dips.length).toBeGreaterThan(0);
      for (const set of dips) {
        // step_kg=0 을 넘기면 엔진이 INVALID_INPUT 을 낸다 → BASELINE 이어야 맨몸 경로가 맞다.
        expect(set.reasonCode).toBe("BASELINE");
        expect(set.recommendedWeight).toBeNull();
        expect(set.targetRepsLow).toBe(6);
      }
    });

    it("시간 종목(e_plank)은 반복 대신 목표 유지 시간을 처방한다", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/programs/generate")
        .send(await controlledBodyweightProgram())
        .expect(201);

      const plank = response.body.sessions
        .flatMap((session: { exercises: unknown[] }) => session.exercises)
        .find((exercise: { exercise_id: string }) => exercise.exercise_id === "e_plank");
      // 시드 e_plank: default_time_low_sec 20 / high 60
      expect(plank).toMatchObject({
        reps_low: null,
        reps_high: null,
        target_rir: null,
        time_low_sec: 20,
        time_high_sec: 60,
      });
      await materializeCurrent();

      const stored = await prisma.plannedSet.findMany({
        where: { session: { program: { userId: USER_ID } }, exerciseId: "e_plank" },
      });
      expect(stored.length).toBeGreaterThan(0);
      for (const set of stored) {
        expect(set.recommendedWeight).toBeNull();
        expect(set.recommendedReps).toBeNull();
        expect(set.targetTimeLowSec).toBe(20);
        expect(set.targetTimeHighSec).toBe(60);
        expect(set.reasonCode).toBe("BASELINE");
      }
    });
  });

  /**
   * 통증 부위 제외 필터 — 매핑표의 유일한 출처는 docs/SAFETY_PAIN_MAPPING.md 다.
   * 기대값을 코드에 복사하지 않고 문서에 적힌 패턴을 그대로 확인한다.
   */
  describe("pain_areas 제외 필터 (SAFETY_PAIN_MAPPING.md)", () => {
    async function generateWith(painAreas: string[]) {
      const response = await request(app.getHttpServer())
        .post("/v1/programs/generate")
        .send({ ...BASE, pain_areas: painAreas })
        .expect(201);
      const exerciseIds: string[] = response.body.sessions.flatMap(
        (session: { exercises: { exercise_id: string }[] }) =>
          session.exercises.map((exercise) => exercise.exercise_id),
      );
      const used = await prisma.exercise.findMany({ where: { id: { in: exerciseIds } } });
      return { body: response.body, exerciseIds, patterns: used.map((e) => e.movementPattern) };
    }

    it.each([
      ["knee", ["squat", "lunge", "knee_extension"]],
      ["lower_back", ["hinge", "squat"]],
      ["shoulder", ["vertical_push", "horizontal_push", "shoulder_isolation"]],
      ["ankle", ["lunge", "calf", "squat"]],
    ])("pain_areas=[%s] 면 %p 패턴 운동이 하나도 없다", async (area, excluded) => {
      const { patterns, exerciseIds } = await generateWith([area]);

      expect(exerciseIds.length).toBeGreaterThan(0);
      for (const pattern of excluded) {
        expect(patterns).not.toContain(pattern);
      }
    });

    it("제외 근거(excluded_exercises)가 응답에 들어간다", async () => {
      const { body } = await generateWith(["knee"]);

      expectMatchesContract("post", "/programs/generate", 201, body);
      const excluded = body.excluded_exercises;
      const expected = await prisma.exercise.findMany({
        where: { movementPattern: { in: ["squat", "lunge", "knee_extension"] } },
        select: { id: true },
      });
      expect(excluded.map((item: { exercise_id: string }) => item.exercise_id)).toEqual(
        expected.map((exercise) => exercise.id).sort((a, b) => a.localeCompare(b)),
      );
      expect(
        excluded.every(
          (item: { pain_area: string; movement_pattern: string }) =>
            item.pain_area === "knee" &&
            ["squat", "lunge", "knee_extension"].includes(item.movement_pattern),
        ),
      ).toBe(true);
      // 규칙 6: 의료적 조언이 아니라는 안내를 근거 문구에 담는다.
      expect(
        excluded.every((item: { reason: string }) => item.reason.includes("의료적 조언이 아니다")),
      ).toBe(true);
    });

    it("제외가 없으면 excluded_exercises 는 빈 배열이다", async () => {
      const { body } = await generateWith([]);

      expect(body.excluded_exercises).toEqual([]);
    });

    /** 규칙 1: 제외로 자리가 비면 같은 근육군의 머신/케이블 종목으로 메운다(에러 금지 — 규칙 2). */
    it("무릎 제외로 비는 하체는 머신/케이블 대체 종목으로 채운다", async () => {
      const { body } = await generateWith(["knee"]);

      const lower = body.sessions.find((session: { focus: string }) => session.focus === "lower");
      const ids = lower.exercises.map((exercise: { exercise_id: string }) => exercise.exercise_id);
      expect(ids.length).toBeGreaterThan(0);
      const used = await prisma.exercise.findMany({ where: { id: { in: ids } } });
      // quads/glutes 를 잃었으므로 같은 근육군(hamstrings/glutes)의 머신 종목이 들어온다.
      expect(ids).toContain("e_leg_curl");
      expect(used.filter((e) => ["machine", "cable"].includes(e.equipment)).length).toBeGreaterThan(
        0,
      );
    });

    /** 규칙 4: wrist 는 제외 패턴이 없고 머신/케이블 우선 정렬만 적용한다. */
    it("wrist 는 아무 운동도 제외하지 않고 머신/케이블을 먼저 고른다", async () => {
      const { body, exerciseIds } = await generateWith(["wrist"]);

      expect(body.excluded_exercises).toEqual([]);
      const used = await prisma.exercise.findMany({ where: { id: { in: exerciseIds } } });
      const stable = used.filter((e) => ["machine", "cable"].includes(e.equipment));
      expect(stable.length).toBeGreaterThan(used.length / 2);
    });

    /**
     * D-2: 제외가 0건인 부위(wrist)도 프로그램에 **기록**은 남긴다 — 즉석 세션(F8-1)이 여기서
     * 통증 부위를 되읽어 머신/케이블 우선을 다시 적용하기 때문이다. exercise_id="" 가 "제외한 운동 없음"
     * 표시이고, 응답에서는 걸러낸다(위 테스트의 excluded_exercises=[] 가 그대로 유지된다).
     */
    it("제외 0건인 부위(wrist)도 통증 부위 기록은 남는다", async () => {
      await generateWith(["wrist"]);

      const program = await prisma.program.findFirstOrThrow({ where: { userId: USER_ID } });
      expect(program.excludedExercises).toEqual([
        { exercise_id: "", pain_area: "wrist", movement_pattern: "", reason: expect.any(String) },
      ]);
    });

    /**
     * 안전 입력은 조용히 실패하면 안 된다(계약 변경, 기술총괄 판단): 예전에는 모르는 부위를 무시했는데
     * 그러면 오타·대소문자·한글이 전부 통과해 "통증을 입력했지만 아무것도 제외되지 않는" 상태가 된다
     * (최종 평가 재현: pain_areas=["Knee","무릎",...] → excluded_exercises=[], e_back_squat 배정).
     */
    it.each(["Knee", "knee ", "무릎", "lowerback", "knees", "left_pinky"])(
      "알 수 없는 pain_area(%p)는 400 이고 프로그램을 만들지 않는다",
      async (area) => {
        const response = await request(app.getHttpServer())
          .post("/v1/programs/generate")
          .send({ ...BASE, pain_areas: [area] });

        expectErrorMatchesContract("post", "/programs/generate", 400, response);
        expect(response.body.error.code).toBe("VALIDATION_ERROR");
        await expect(prisma.program.count({ where: { userId: USER_ID } })).resolves.toBe(0);
      },
    );

    it("매핑표의 8개 부위는 그대로 통과한다", async () => {
      for (const area of PAIN_AREAS) {
        const { body, exerciseIds } = await generateWith([area]);
        expectMatchesContract("post", "/programs/generate", 201, body);
        expect(exerciseIds.length).toBeGreaterThan(0);
      }
    });

    /** 문서(매핑표) → 계약(openapi enum) → 검증(DTO)이 갈라지면 안전 필터가 다시 조용해진다. */
    it("openapi enum = SAFETY_PAIN_MAPPING.md 매핑표 = 서버가 받는 부위", () => {
      const doc = parse(readFileSync(OPENAPI_PATH, "utf8")) as {
        components: {
          schemas: {
            GenerateProgramRequest: { properties: { pain_areas: { items: { enum: string[] } } } };
          };
        };
      };
      const documented = [
        ...readFileSync(SAFETY_MAPPING_PATH, "utf8").matchAll(/^\| `([a-z_]+)`/gm),
      ].map((match) => match[1]);

      expect(PAIN_AREAS.length).toBe(8);
      expect(
        [...doc.components.schemas.GenerateProgramRequest.properties.pain_areas.items.enum].sort(),
      ).toEqual([...PAIN_AREAS].sort());
      expect(documented.sort()).toEqual([...PAIN_AREAS].sort());
    });
  });

  it("GET /programs/current → 200 + 방금 생성한 프로그램(스키마 일치)", async () => {
    const created = await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send(BASE)
      .expect(201);

    const response = await request(app.getHttpServer()).get("/v1/programs/current").expect(200);

    expectMatchesContract("get", "/programs/current", 200, response.body);
    expect(response.body).toEqual(created.body);
  });

  /**
   * F5 루틴 편집은 **세션 스코프(오늘만)** 다 — 프로그램 템플릿을 바꾸면 안 된다(STEP 4 평가 I-12).
   */
  it("세션 편집은 GET /programs/current 템플릿을 바꾸지 않는다", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE).expect(201);
    const before = await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
    const session = await prisma.workoutSession.findFirstOrThrow({
      where: { program: { userId: USER_ID } },
      orderBy: { scheduledDate: "asc" },
    });

    await request(app.getHttpServer())
      .post(`/v1/sessions/${session.id}/exercises`)
      .send({ exercise_id: "e_face_pull" })
      .expect(200);
    const removed = (
      await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId: session.id },
        orderBy: { orderIndex: "asc" },
      })
    ).exerciseId;
    await request(app.getHttpServer())
      .delete(`/v1/sessions/${session.id}/exercises/${removed}`)
      .expect(200);

    const after = await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
    expect(after.body).toEqual(before.body);
  });

  it("프로그램을 다시 생성하면 current 는 최신 프로그램을 돌려준다", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE).expect(201);
    const second = await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({ ...BASE, goal: "diet", days_per_week: 3, minutes_per_day: 30 })
      .expect(201);

    const response = await request(app.getHttpServer()).get("/v1/programs/current").expect(200);

    expect(response.body.program_id).toBe(second.body.program_id);
    expect(response.body.split_type).toBe("full_body");
    expect(response.body.sessions).toHaveLength(3);
    expect(response.body.sessions[0].exercises).toHaveLength(3);
  });
});

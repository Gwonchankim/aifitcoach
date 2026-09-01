/**
 * 통합 테스트(실제 postgres): GET /exercises · GET /exercises/{exerciseId}.
 *
 * 카탈로그는 확장 가능한 참조 데이터라 사용자 데이터를 만들지 않는다.
 * 모든 2xx 응답은 openapi 계약(ajv + 키셋)으로 검증한다 — 계약에 없는 컬럼(default_step_kg 등)이
 * 새면 expectMatchesContract 가 잡는다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp } from "./support/app";
import { expectErrorMatchesContract, expectMatchesContract } from "./support/openapi-response";

const LIST_PATH = "/exercises";
const DETAIL_PATH = "/exercises/{exerciseId}";

interface ExerciseItem {
  id: string;
  movement_pattern: string;
  equipment: string;
  metric: string;
  rep_range_low?: number;
  rep_range_high?: number;
  default_time_low_sec: number | null;
  default_time_high_sec: number | null;
  media_url: string | null;
}

interface ListBody {
  items: ExerciseItem[];
  next_cursor?: string;
}

interface SeedExercise {
  id: string;
  movement_pattern: string;
  equipment: string;
}

const SEED_PATH = path.resolve(__dirname, "..", "..", "..", "docs", "specs", "exercises_seed.json");
const seedExercises = (JSON.parse(readFileSync(SEED_PATH, "utf8")) as { exercises: SeedExercise[] })
  .exercises;

describe("운동 카탈로그 API", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seededIds: string[];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    const rows = await prisma.exercise.findMany({ select: { id: true }, orderBy: { id: "asc" } });
    seededIds = rows.map((row) => row.id);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** 한 페이지 조회 + 계약 검증. 쿼리는 계약에 있는 것만 쓴다. */
  async function fetchPage(query: Record<string, string> = {}): Promise<ListBody> {
    const response = await request(app.getHttpServer())
      .get("/v1/exercises")
      .query(query)
      .expect(200);
    expectMatchesContract("get", LIST_PATH, 200, response.body);
    return response.body as ListBody;
  }

  /** next_cursor 를 따라 끝까지 순회하며 모든 페이지를 모은다. */
  async function fetchAllPages(query: Record<string, string> = {}): Promise<ListBody[]> {
    const pages: ListBody[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetchPage(cursor === undefined ? query : { ...query, cursor });
      pages.push(page);
      cursor = page.next_cursor;
      // 커서가 전진하지 않으면 무한 루프다 → 순회 자체가 실패해야 한다.
      expect(pages.length).toBeLessThanOrEqual(seededIds.length + 1);
    } while (cursor !== undefined);
    return pages;
  }

  function expectedIds(where: (exercise: SeedExercise) => boolean): string[] {
    const matching = new Set(seedExercises.filter(where).map((exercise) => exercise.id));
    return seededIds.filter((id) => matching.has(id));
  }

  it("DB 카탈로그가 시드 파일의 ID 전량과 일치한다", () => {
    expect(seededIds).toHaveLength(seedExercises.length);
    expect(new Set(seededIds)).toEqual(new Set(seedExercises.map((exercise) => exercise.id)));
  });

  describe("GET /exercises (필터 없음)", () => {
    it("커서 순회로 시드 전량을 돌려준다 — 중복 0 · 누락 0", async () => {
      const pages = await fetchAllPages();

      const ids = pages.flatMap((page) => page.items.map((item) => item.id));
      expect(ids).toHaveLength(seededIds.length); // 중복이 있으면 길이가 늘어난다
      expect(new Set(ids).size).toBe(seededIds.length); // 중복 0
      expect(new Set(ids)).toEqual(new Set(seededIds)); // 누락 0
      // 정렬 기준은 DB 콜레이션이다(JS 의 .sort() 와 다르다: e_lateral_raise < e_lat_pulldown).
      // 커서 비교(id > cursor)와 ORDER BY 가 같은 콜레이션을 쓰므로 페이지 경계가 어긋나지 않는다.
      expect(ids).toEqual(seededIds);
    });

    it("페이지 크기 20 — 마지막 페이지에서만 next_cursor 가 없다", async () => {
      const pages = await fetchAllPages();

      const fullPages = Math.floor(seededIds.length / 20);
      const remainder = seededIds.length % 20;
      const expectedSizes = [
        ...Array.from({ length: fullPages }, () => 20),
        ...(remainder === 0 ? [] : [remainder]),
      ];
      expect(pages.map((page) => page.items.length)).toEqual(expectedSizes);
      for (const page of pages.slice(0, -1)) {
        expect(page.next_cursor).toBe(page.items.at(-1)?.id);
      }
      expect(pages.at(-1)).not.toHaveProperty("next_cursor");
    });

    it("커서는 keyset 이다 — cursor 이후(id 오름차순)만 돌려준다", async () => {
      const cursor = seededIds[9];

      const page = await fetchPage({ cursor });

      expect(page.items.map((item) => item.id)).toEqual(seededIds.slice(10, 30));
    });
  });

  describe("GET /exercises (필터)", () => {
    it("pattern 으로 거른다", async () => {
      const items = (await fetchAllPages({ pattern: "horizontal_push" })).flatMap(
        (page) => page.items,
      );

      expect(items.map((item) => item.id)).toEqual(
        expectedIds((exercise) => exercise.movement_pattern === "horizontal_push"),
      );
      expect(items.every((item) => item.movement_pattern === "horizontal_push")).toBe(true);
    });

    it("equipment 로 거른다", async () => {
      const items = (await fetchAllPages({ equipment: "bodyweight" })).flatMap(
        (page) => page.items,
      );

      expect(items.map((item) => item.id)).toEqual(
        expectedIds((exercise) => exercise.equipment === "bodyweight"),
      );
      expect(items.every((item) => item.equipment === "bodyweight")).toBe(true);
    });

    it("pattern + equipment 는 함께 적용된다", async () => {
      const items = (
        await fetchAllPages({ pattern: "horizontal_push", equipment: "bodyweight" })
      ).flatMap((page) => page.items);

      expect(items.map((item) => item.id)).toEqual(
        expectedIds(
          (exercise) =>
            exercise.movement_pattern === "horizontal_push" && exercise.equipment === "bodyweight",
        ),
      );
      expect(
        items.every(
          (item) => item.movement_pattern === "horizontal_push" && item.equipment === "bodyweight",
        ),
      ).toBe(true);
    });

    it("필터를 걸어도 커서 순회 결과는 필터 없는 전량의 부분집합이다", async () => {
      const filtered = (await fetchAllPages({ equipment: "dumbbell" })).flatMap(
        (page) => page.items,
      );

      const expected = expectedIds((exercise) => exercise.equipment === "dumbbell");
      expect(filtered.map((item) => item.id)).toEqual(expected);
      expect(filtered.every((item) => item.equipment === "dumbbell")).toBe(true);
      expect(new Set(filtered.map((item) => item.id)).size).toBe(expected.length);
    });

    it("enum 밖의 값은 빈 목록이다(계약에 400 이 없다)", async () => {
      const page = await fetchPage({ pattern: "bogus_pattern" });

      expect(page).toEqual({ items: [] });
    });
  });

  describe("계약 매핑", () => {
    it("metric=time(e_plank)은 rep_range_* 없이 time 범위를 준다", async () => {
      const page = await fetchPage({ pattern: "core" });
      const plank = page.items.find((item) => item.id === "e_plank")!;

      expect(plank).toEqual({
        id: "e_plank",
        name_ko: "플랭크",
        name_en: "Plank",
        movement_pattern: "core",
        primary_muscles: ["abs"],
        equipment: "bodyweight",
        difficulty: "beginner",
        mechanic: "isolation",
        region: "core",
        metric: "time",
        step_kg: null,
        default_time_low_sec: 20,
        default_time_high_sec: 60,
        substitutions: ["e_cable_crunch"],
        media_url: null,
      });
    });

    it("맨몸 반복 종목(e_dips)은 rep_range_* 를 주고 무게 관련 컬럼을 노출하지 않는다", async () => {
      const response = await request(app.getHttpServer()).get("/v1/exercises/e_dips").expect(200);

      expectMatchesContract("get", DETAIL_PATH, 200, response.body);
      expect(response.body).toEqual({
        id: "e_dips",
        name_ko: "딥스",
        name_en: "Dips",
        movement_pattern: "horizontal_push",
        primary_muscles: ["chest", "triceps"],
        equipment: "bodyweight",
        difficulty: "intermediate",
        mechanic: "compound",
        region: "upper",
        metric: "reps",
        step_kg: null,
        rep_range_low: 6,
        rep_range_high: 15,
        default_time_low_sec: null,
        default_time_high_sec: null,
        substitutions: ["e_chest_press_machine", "e_triceps_pushdown"],
        media_url: null,
      });
      // DB 컬럼명은 노출하지 않고 D-31 계약의 step_kg(null)로 정규화한다.
      expect(response.body).not.toHaveProperty("default_step_kg");
    });
  });

  describe("GET /exercises/{exerciseId}", () => {
    it("존재하면 200 이고 계약을 만족한다", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/exercises/e_bench_press")
        .expect(200);

      expectMatchesContract("get", DETAIL_PATH, 200, response.body);
      expect(response.body).toMatchObject({
        id: "e_bench_press",
        movement_pattern: "horizontal_push",
        rep_range_low: 5,
        rep_range_high: 12,
      });
    });

    it("신규 스미스 인클라인도 계약대로 나온다 — 새 필드·새 enum 값 없이", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/exercises/e_smith_incline_bench_press")
        .expect(200);

      // 계약 검증이 핵심이다. taxonomy 축을 늘렸다면 여기서 계약 위반으로 잡힌다.
      expectMatchesContract("get", DETAIL_PATH, 200, response.body);
      expect(response.body).toMatchObject({
        id: "e_smith_incline_bench_press",
        movement_pattern: "horizontal_push",
        equipment: "machine",
        metric: "reps",
        rep_range_low: 8,
        rep_range_high: 12,
      });
    });

    it("없으면 404 + 에러 엔벨로프", async () => {
      const response = await request(app.getHttpServer()).get("/v1/exercises/e_nope");

      expectErrorMatchesContract("get", DETAIL_PATH, 404, response);
      expect((response.body as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    });
  });
});

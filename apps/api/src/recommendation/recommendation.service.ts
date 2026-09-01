import { Injectable } from "@nestjs/common";
import type { Exercise } from "@prisma/client";
import { PAIN_STOP_THRESHOLD, recommendNextSet } from "shared";
import type {
  Goal,
  LoadKind,
  PainObservation,
  PerformedSet,
  ReasonCode,
  Recommendation,
  RecommendationInput,
  RecommendationState,
  RecommendedAction,
} from "shared";
import { PrismaService } from "../prisma/prisma.service";
import { mergePainObservations, readPainObservation } from "./pain-observation.adapter";
import { rulesVersionForLoadSemantics } from "../programs/assistance-migration";
import { RULES_VERSION } from "../programs/program-rules";

/** openapi: components.schemas.Recommendation */
export interface ApiRecommendation {
  exercise_id: string;
  /** null = 자체중량(맨몸·시간 종목) — 추가 부하를 처방하지 않는다. */
  weight: number | null;
  /** metric=time 종목은 반복 축이 없다 → null. */
  reps_low: number | null;
  reps_high: number | null;
  sets: number;
  /** metric=time 종목에서만 나온다. */
  time_low_sec?: number;
  time_high_sec?: number;
  reason_code: string;
  confidence: number;
  explanation: string;
  rules_version: string;
  /**
   * 부하 축의 의미. `assistance` 는 숫자가 **기계가 덜어주는 kg** 이라 방향이 반대다 —
   * 클라이언트가 null 하나로 "무게 미정"과 "자체중량"을 구분하지 못하므로 명시한다.
   */
  load_kind: LoadKind;
  recommendation_state: RecommendationState;
  /** 최소 경계의 종목 전환 제안에만 쓴다. 안전 상태에서는 **항상 null**이다. */
  recommended_action: RecommendedAction | null;
}

/** 엔진 입력의 target. metric=reps 는 reps_low/reps_high/rir, metric=time 은 time_*_sec 를 채운다. */
export type EngineTarget = RecommendationInput["target"];

/**
 * lifetime graduation 근거. **public payload 로 내보내지 않는다** —
 * `calibration_source_performed_set_id` 는 내부 audit·테스트용이다(§F).
 */
export interface AssistanceEvidence {
  has_valid_positive_assistance: boolean;
  calibration_source_performed_set_id: string | null;
}

export interface ExerciseHistory {
  lastSets: PerformedSet[];
  /**
   * 직전 세션의 통증 관측값. **숫자가 아니라 tagged 값**이다 —
   * "없음"·"0점"·"못 읽음"은 서로 다른 사실이고, 못 읽은 것을 없는 것으로 읽으면
   * 손상된 행이 조용히 안전 가드레일을 통과한다.
   */
  pain?: PainObservation;
  /** 어시스트 종목에서만 채운다. 최근 세션이 아니라 **전체 이력**이 원천이다. */
  assistance?: { has_valid_positive_assistance: boolean };
}

export const NO_HISTORY: ExerciseHistory = { lastSets: [] };

/** batch prefetch 의 요청 단위. semantics 는 **그 행이 저장될/저장된 의미**다. */
export interface ExerciseSpec {
  exerciseId: string;
  loadSemantics: "assistance" | "external_load";
}
export type HistoryMap = Map<string, ExerciseHistory>;

/**
 * prefetch map 에서 꺼낸다. **키가 없으면 invariant 위반이라 던진다.**
 *
 * 기본값으로 조용히 메우면 prefetch 를 빠뜨린 caller 가 "이력 없음"으로 계산돼
 * **사용자 처방이 조용히 초기화된다** — 화면에는 아무 에러도 안 뜬다.
 * `prefetchHistories` 는 요청한 spec 을 **전부** map 에 넣으므로 miss 는 코드 결함뿐이다.
 */
export function requireHistory(map: HistoryMap, exerciseId: string): ExerciseHistory {
  const found = map.get(exerciseId);
  if (found === undefined) {
    throw new Error(`prefetch 되지 않은 종목의 이력을 요구했다: ${exerciseId}`);
  }
  return found;
}

/**
 * 읽기에 쓸 client. **트랜잭션 안에서 부를 때는 그 트랜잭션 client 를 넘긴다** —
 * 바깥 client 로 읽으면 스냅샷이 달라지고 잠금 밖에서 읽어 결과가 흔들린다.
 */
export type DbClient = Pick<
  PrismaService,
  "performedSet" | "userRirCalibration" | "assistanceAudit"
>;

/** latest history 에 필요한 **최소 필드**만. 통증은 tagged 로 읽고 값은 밖으로 내지 않는다. */
const LATEST_HISTORY_SELECT = {
  id: true,
  actualWeight: true,
  actualReps: true,
  actualRir: true,
  actualTimeSec: true,
  painScore: true,
  performedAt: true,
  plannedSet: {
    select: {
      exerciseId: true,
      setNo: true,
      sessionId: true,
      session: { select: { completedAt: true, scheduledDate: true } },
    },
  },
};

export type LatestHistoryRow = {
  id: string;
  actualWeight: { toString(): string } | null;
  actualReps: number | null;
  actualRir: number | null;
  actualTimeSec: number | null;
  painScore: string | null;
  performedAt: Date;
  plannedSet: {
    setNo: number;
    sessionId: string;
    session: { completedAt: Date | null; scheduledDate: Date };
  };
};

/**
 * **최신 세션 선택은 결정론적이어야 한다.** 같은 날짜에 세션이 둘이면 무엇을 "직전"으로 볼지
 * 정하지 않으면 실행마다 추천이 흔들린다.
 *
 * 순서: 예정일 desc → 완료/수행 시각 desc → 세션 id desc.
 * 고른 세션 **안에서는** set_no asc → performed id asc(사용자가 수행한 순서).
 * graduation 의 earliest asc 정렬과는 **별개**다.
 */
export function latestHistoryFrom(rows: LatestHistoryRow[]): ExerciseHistory {
  if (rows.length === 0) return NO_HISTORY;
  const latest = [...rows].sort((a, b) => {
    const date =
      b.plannedSet.session.scheduledDate.getTime() - a.plannedSet.session.scheduledDate.getTime();
    if (date !== 0) return date;
    const at =
      (b.plannedSet.session.completedAt ?? b.performedAt).getTime() -
      (a.plannedSet.session.completedAt ?? a.performedAt).getTime();
    if (at !== 0) return at;
    if (a.plannedSet.sessionId !== b.plannedSet.sessionId)
      return a.plannedSet.sessionId < b.plannedSet.sessionId ? 1 : -1;
    return 0;
  })[0];

  const sessionRows = rows
    .filter((row) => row.plannedSet.sessionId === latest.plannedSet.sessionId)
    // set_no 하나로 전순서가 정해진다(위와 같은 unique 근거).
    .sort((a, b) => a.plannedSet.setNo - b.plannedSet.setNo);
  return toHistory(sessionRows);
}

const EMPTY_EVIDENCE: AssistanceEvidence = {
  has_valid_positive_assistance: false,
  calibration_source_performed_set_id: null,
};

/**
 * 통증 복호화 실패 audit 의 exact action. **failure code 만 남긴다** —
 * 값·암호문·performed id 는 어디에도 쓰지 않는다(SECURITY_PIPA.md).
 */
const PAIN_AUDIT_ACTION: Record<string, string> = {
  decrypt_failed: "pain_observation_decrypt_failed",
  auth_failed: "pain_observation_auth_failed",
  nonnumeric: "pain_observation_nonnumeric",
};

/**
 * graduation source 는 **가장 이른 valid 관측**이다. tie 는 결정론적으로 끊는다:
 * 예정일 → 수행시각 → 세션 id → set_no → performed id (전부 asc).
 */
export function compareEarliestFirst(
  a: {
    id: string;
    performedAt: Date;
    plannedSet: { setNo: number; session: { id: string; scheduledDate: Date } };
  },
  b: typeof a,
): number {
  const date =
    a.plannedSet.session.scheduledDate.getTime() - b.plannedSet.session.scheduledDate.getTime();
  if (date !== 0) return date;
  const at = a.performedAt.getTime() - b.performedAt.getTime();
  if (at !== 0) return at;
  if (a.plannedSet.session.id !== b.plannedSet.session.id)
    return a.plannedSet.session.id < b.plannedSet.session.id ? -1 : 1;
  // **여기서 끝이다.** 같은 세션·같은 종목에서 같은 set_no 를 가진 performed 행은
  // 존재할 수 없다 — ux_planned_session_exercise_set(sessionId, exerciseId, setNo) 와
  // PerformedSet.plannedSetId 의 unique 가 그 조합을 하나로 고정한다.
  // 도달 불가한 id fallback 을 두면 "검증된 적 없는 규칙"이 계약처럼 남는다.
  return a.plannedSet.setNo - b.plannedSet.setNo;
}

/** reason_code → 사용자에게 보여줄 근거 문장(openapi Recommendation.explanation). 표시 문구일 뿐 규칙이 아니다. */
const EXPLANATION: Record<ReasonCode, string> = {
  WEIGHT_UP_REP_TARGET_MET: "모든 세트가 목표 반복 상단에 도달해 한 스텝 증량한다.",
  ADD_ONE_REP: "무게는 유지하고 목표 반복을 1회 늘린다.",
  HOLD_RIR_LOW: "반복은 지켰지만 RIR 이 낮아 무게를 유지한다.",
  TOO_HARD: "목표 반복에 미달해 부하를 낮춘다.",
  LOAD_CALIBRATION_NEEDED:
    "기록이 없어 첫 작업중량을 캘리브레이션으로 정한다(무게만 미정, 목표 반복은 유효).",
  BASELINE: "기록이 없어 워밍업으로 시작 무게를 정한다.",
  INVALID_INPUT: "진행 규칙을 적용할 입력(증량 단위·목표 반복)이 부족하다.",
  SUBSTITUTE_PAIN: "통증이 보고되어 부하를 낮추고 대체 운동을 제안한다.",
  RIR_TOO_EASY_INCREASE: "RIR 이 목표보다 높아(여유가 많아) 증량한다.",
  RIR_TOO_HARD_REDUCE: "RIR 이 목표보다 낮아(과부하) 무게를 낮춘다.",
  REPS_UP_BODYWEIGHT: "자체중량 종목이라 무게 대신 목표 반복 상단을 1회 올린다.",
  PROGRESSION_CAP_BODYWEIGHT: "반복 상한에 도달해 가중(웨이트 벨트)이나 더 어려운 변형을 제안한다.",
  SUBSTITUTE_TOO_HARD_BODYWEIGHT:
    "자체중량이 아직 무거워 보조 종목(머신·케이블)으로 대체를 제안한다.",
  TIME_UP: "모든 세트가 목표 유지 시간 상단에 도달해 목표 시간을 늘린다.",
  TIME_HOLD: "목표 유지 시간 범위 안이라 현재 목표를 유지한다.",
  TIME_DOWN: "목표 유지 시간 하단에 크게 미달해 목표 시간을 낮춘다.",
  // 어시스트 종목: 숫자는 기계가 덜어주는 kg 이라 **줄어야 어려워진다**.
  // generic 증량 문구를 재사용하면 숫자 방향과 설명이 서로 어긋난다.
  ASSISTANCE_CALIBRATION_NEEDED:
    "도움 기록이 없어 편안한 도움 무게부터 직접 정한다. 충분한 도움에서 시작해 단계적으로 줄인다.",
  ASSISTANCE_DOWN_REP_TARGET_MET: "목표 반복을 채워 도움을 한 스텝 줄인다.",
  ASSISTANCE_DOWN_RIR_EASY: "RIR 이 목표보다 높아(여유가 많아) 도움을 줄인다.",
  ASSISTANCE_UP_RIR_HARD: "RIR 이 목표보다 낮아(과부하) 도움을 늘린다.",
  ASSISTANCE_UP_TOO_HARD: "목표 반복에 미달해 도움을 늘린다.",
  ASSISTANCE_MINIMUM_REACHED:
    "도움을 더 줄이면 0 이하가 되어 현재 값을 유지한다. 맨몸 턱걸이로의 전환을 고려해 볼 수 있다.",
};

/**
 * 어시스트 안전 상태의 **확정 문구**(§F safety matrix). reason 별 기본 문구를 덮어쓴다.
 *
 * generic `SUBSTITUTE_PAIN` 문구는 "부하를 낮추고" 라고 말한다 — 어시스트에서 부하를 낮추는 것은
 * **도움을 늘리는 것**이라 방향이 정반대다. 통증 상태에서 그 문구를 쓰면 안 된다.
 */
const ASSISTANCE_SAFETY_COPY: Partial<Record<RecommendationState, string>> = {
  substitution_required: "통증이 있어 이 운동을 중단하고 무통 대체 운동으로 바꾸세요.",
  unavailable: "입력값을 확인한 뒤 다시 시도하세요.",
};

/** reason + 상태 + 부하 유형을 함께 보는 문구 선택. 어시스트 안전 상태만 덮어쓴다. */
export function explanationFor(
  reason: ReasonCode,
  state: RecommendationState,
  loadKind: LoadKind,
): string {
  if (loadKind === "assistance") {
    const override = ASSISTANCE_SAFETY_COPY[state];
    if (override !== undefined) return override;
  }
  return EXPLANATION[reason];
}

/**
 * 추천 엔진(packages/shared) 호출을 위한 입력 조립 + 응답 매핑.
 * 규칙(무게·반복·reason_code)은 전부 recommendNextSet 안에 있고 여기서 재구현하지 않는다.
 */
@Injectable()
export class RecommendationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * calibration 객체의 **존재 자체가 RIR 축 활성 스위치**다(PROGRESS.md STEP 3).
   * 튜토리얼을 마치지 않은 사용자에게 rir_bias: 0 을 채워 넣으면 안 되고 undefined 를 돌려준다.
   */
  async calibrationFor(
    userId: string,
    client: DbClient = this.prisma,
  ): Promise<{ rir_bias: number } | undefined> {
    const row = await client.userRirCalibration.findUnique({ where: { userId } });
    if (!row || row.status !== "graduated") {
      return undefined;
    }
    return { rir_bias: Number(row.biasOverall) };
  }

  /**
   * 해당 운동을 마지막으로 수행한 완료 세션의 세트들(없으면 빈 배열).
   *
   * 어시스트 종목이면 **lifetime graduation 근거를 따로 붙인다** — 최신 세션 하나로는
   * "이미 넘은 관문"을 알 수 없다. `loadSemantics` 는 호출자가 카탈로그에서 넘긴다.
   */
  async historyFor(
    userId: string,
    exerciseId: string,
    loadSemantics: "assistance" | "external_load" = "external_load",
  ): Promise<ExerciseHistory> {
    const base = await this.latestSessionHistory(userId, exerciseId);
    if (loadSemantics !== "assistance") return base;
    const evidence = await this.assistanceEvidenceFor(userId, exerciseId);
    return {
      ...base,
      assistance: { has_valid_positive_assistance: evidence.has_valid_positive_assistance },
    };
  }

  /**
   * **production loop 용 batch prefetch.** 종목마다 `historyFor` 를 부르면 프로그램 생성·recompute 가
   * 종목 수만큼 질의한다. 요청 spec 전체를 **고정 횟수**(latest 1 + lifetime 1)로 읽어 map 으로 준다.
   *
   * `loadSemantics` 는 **그 행이 저장될/저장된 의미**다 — 카탈로그가 나중에 바뀌어도 과거 기록의
   * 해석이 흔들리지 않게 latest history 도 **같은 semantics 의 실측만** 쓴다.
   */
  async prefetchHistories(
    userId: string,
    specs: ExerciseSpec[],
    client: DbClient = this.prisma,
  ): Promise<HistoryMap> {
    const map: HistoryMap = new Map();
    if (specs.length === 0) return map;
    const unique = new Map(specs.map((spec) => [spec.exerciseId, spec]));
    const wanted = [...unique.values()];

    const rows = await client.performedSet.findMany({
      where: {
        completed: true,
        // tenancy 를 **각 분기 안에** 둔다 — OR 밖으로 빼면 다른 사용자의 행이 새어 들어온다.
        OR: wanted.map((spec) => ({
          plannedSet: {
            exerciseId: spec.exerciseId,
            loadSemantics: spec.loadSemantics,
            session: { status: "completed", program: { userId } },
          },
        })),
      },
      select: LATEST_HISTORY_SELECT,
    });

    const byExercise = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byExercise.get(row.plannedSet.exerciseId) ?? [];
      list.push(row);
      byExercise.set(row.plannedSet.exerciseId, list);
    }

    const assisted = wanted.filter((spec) => spec.loadSemantics === "assistance");
    const evidence = new Map(
      await this.assistanceEvidenceForMany(
        userId,
        assisted.map((s) => s.exerciseId),
        client,
      ),
    );

    for (const spec of wanted) {
      const list = byExercise.get(spec.exerciseId) ?? [];
      const history = latestHistoryFrom(list);
      const found = evidence.get(spec.exerciseId);
      map.set(
        spec.exerciseId,
        spec.loadSemantics === "assistance"
          ? {
              ...history,
              assistance: {
                has_valid_positive_assistance: found?.has_valid_positive_assistance ?? false,
              },
            }
          : history,
      );
    }
    return map;
  }

  private async latestSessionHistory(userId: string, exerciseId: string): Promise<ExerciseHistory> {
    const rows = await this.prisma.performedSet.findMany({
      where: {
        completed: true,
        plannedSet: { exerciseId, session: { status: "completed", program: { userId } } },
      },
      select: {
        actualWeight: true,
        actualReps: true,
        actualRir: true,
        actualTimeSec: true,
        painScore: true,
        plannedSet: {
          select: { setNo: true, sessionId: true, session: { select: { scheduledDate: true } } },
        },
      },
    });
    if (rows.length === 0) {
      return NO_HISTORY;
    }

    const latest = rows.reduce((a, b) =>
      b.plannedSet.session.scheduledDate > a.plannedSet.session.scheduledDate ? b : a,
    );
    const latestRows = rows
      .filter((row) => row.plannedSet.sessionId === latest.plannedSet.sessionId)
      .sort((a, b) => a.plannedSet.setNo - b.plannedSet.setNo);

    return toHistory(latestRows);
  }

  /**
   * **lifetime graduation evidence.** progression 판정(최근 완료 세션 1개)과 **분리된 별도 질의**다.
   *
   * 왜 분리하나: 최신 세션이 통증·손상·도움 0 이어도 **과거에 유효한 양수 도움 기록이 있으면**
   * 캘리브레이션으로 되돌아가면 안 된다. 사용자가 이미 넘은 관문을 다시 닫는 셈이다.
   * 안전 상태는 그대로 우선하되, graduation 근거는 지워지지 않는다.
   *
   * **immutable planned snapshot 으로 필터한다** — 카탈로그가 나중에 바뀌어도 과거 해석이 고정된다.
   * legacy `.08.1` 행의 **planned 처방(무게·반복·reason·state)은 읽지 않는다.** 수행 사실만 쓴다.
   */
  async assistanceEvidenceFor(userId: string, exerciseId: string): Promise<AssistanceEvidence> {
    const [evidence] = await this.assistanceEvidenceForMany(userId, [exerciseId]);
    return evidence?.[1] ?? EMPTY_EVIDENCE;
  }

  /**
   * **exercise batch.** 종목마다 질의하면 프로그램 생성·recompute 에서 N+1 이 된다.
   * tenancy(`userId`)와 snapshot semantics 로 좁히고, 필요한 필드만 select 한다.
   */
  async assistanceEvidenceForMany(
    userId: string,
    exerciseIds: string[],
    client: DbClient = this.prisma,
  ): Promise<Array<[string, AssistanceEvidence]>> {
    if (exerciseIds.length === 0) return [];
    const rows = await client.performedSet.findMany({
      where: {
        completed: true,
        plannedSet: {
          exerciseId: { in: exerciseIds },
          loadSemantics: "assistance",
          session: { status: "completed", program: { userId } },
        },
      },
      select: {
        id: true,
        plannedSetId: true,
        actualWeight: true,
        actualReps: true,
        painScore: true,
        performedAt: true,
        plannedSet: {
          select: {
            exerciseId: true,
            setNo: true,
            session: { select: { id: true, scheduledDate: true } },
          },
        },
      },
    });

    const byExercise = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byExercise.get(row.plannedSet.exerciseId) ?? [];
      list.push(row);
      byExercise.set(row.plannedSet.exerciseId, list);
    }

    // 손상 행은 **전체를 끝까지 훑어** 모은다. 첫 valid 에서 멈추면 그 뒤의 손상을 못 본다.
    const corrupt: { plannedSetId: string; action: string }[] = [];
    const result: Array<[string, AssistanceEvidence]> = [];
    for (const id of exerciseIds) {
      const list = byExercise.get(id) ?? [];
      const ordered = [...list].sort(compareEarliestFirst);
      let source: string | null = null;
      for (const row of ordered) {
        const pain = readPainObservation(row.painScore);
        if (pain.kind === "invalid") {
          // 1:1 `plannedSetId` 는 `(performed_set_id, failure_code)` 와 동치 키다.
          corrupt.push({
            plannedSetId: row.plannedSetId,
            action: PAIN_AUDIT_ACTION[pain.failure_code],
          });
          continue;
        }
        if (source !== null) continue;
        const assistance = row.actualWeight === null ? null : Number(row.actualWeight);
        if (assistance === null || !Number.isFinite(assistance) || assistance <= 0) continue;
        if (row.actualReps === null || row.actualReps < 1) continue;
        if (pain.kind === "value" && pain.value >= PAIN_STOP_THRESHOLD) continue;
        source = row.id;
      }
      result.push([
        id,
        {
          has_valid_positive_assistance: source !== null,
          calibration_source_performed_set_id: source,
        },
      ]);
    }

    await this.recordPainAudits(corrupt, client);
    return result;
  }

  /**
   * 손상 행 audit — **한 번의 batch insert 로 멱등**하게 넣는다.
   * `skipDuplicates` 가 unique 경합을 DB 안에서 흡수하므로 재실행·동시 실행이 사용자 오류가 되지 않는다.
   *
   * **metadata 는 비운다.** 통증 값·암호문·performed id 를 어디에도 넣지 않는다 —
   * 무엇이 왜 실패했는지는 `action` 하나로 충분하다.
   */
  private async recordPainAudits(
    corrupt: { plannedSetId: string; action: string }[],
    client: DbClient,
  ): Promise<void> {
    if (corrupt.length === 0) return;
    const unique = new Map(corrupt.map((row) => [`${row.plannedSetId}:${row.action}`, row]));
    await client.assistanceAudit.createMany({
      data: [...unique.values()].map((row) => ({
        plannedSetId: row.plannedSetId,
        action: row.action,
        metadata: {},
      })),
      skipDuplicates: true,
    });
  }

  /** 엔진 호출. exercise 는 시드 카탈로그 행, target 은 planned_set 의 목표값. */
  recommend(params: {
    goal: Goal;
    exercise: Pick<Exercise, "mechanic" | "region" | "defaultStepKg" | "metric" | "loadSemantics">;
    target: EngineTarget;
    history: ExerciseHistory;
    calibration?: { rir_bias: number };
    /**
     * 갱신 대상 행의 **immutable snapshot**. 있으면 step·bundle 을 이걸로 계산한다 —
     * 카탈로그 `defaultStepKg` 나 전역 active pointer 로 **재구성하지 않는다.**
     *
     * 재구성하면 카탈로그가 2.5 → 5 로 바뀐 뒤 과거 행이 5kg 단위로 계산되고,
     * `.09` 로 저장된 행이 `.08.2` 로 되돌아가 provenance 가 거짓이 된다.
     */
    snapshot?: { stepKg: unknown; rulesVersion: string };
  }): Recommendation {
    const { goal, exercise, target, history, calibration, snapshot } = params;
    const assisted = exercise.loadSemantics === "assistance";
    // 카탈로그는 snapshot 이 없는 metadata(mechanic·region·metric)에만 쓴다.
    const stepSource =
      assisted && snapshot !== undefined ? snapshot.stepKg : exercise.defaultStepKg;
    return recommendNextSet({
      goal,
      exercise: {
        type: exercise.mechanic,
        region: exercise.region,
        // null = 맨몸(자체중량). 0 을 넣으면 엔진이 "잘못된 증량 단위"로 보고 INVALID_INPUT 을 낸다.
        step_kg: stepSource === null || stepSource === undefined ? null : Number(stepSource),
        metric: exercise.metric,
        // 어시스트 종목은 숫자가 "덜어주는 kg" 이라 **방향이 반대**다. 이걸 안 실으면
        // 엔진이 조용히 generic weighted 경로로 떨어져 목표를 채울수록 도움이 늘어난다.
        load_semantics: exercise.loadSemantics,
      },
      target,
      last_sets: history.lastSets,
      ...(calibration ? { calibration } : {}),
      ...safetyInputFor(history.pain),
      ...(history.assistance ? { assistance: history.assistance } : {}),
      // 어시스트 행은 assistance 를 아는 bundle 로 계산한다. `.08.1` 로 부르면 엔진이
      // 어시스트 분기 자체를 타지 않는다(AC 2 — historical `.08.1` 을 복사하지 않는다).
      // 대상 행의 bundle 이 이미 assistance-capable 이면 **그 값을 보존한다**(`.09` 강등 금지).
      rules_version:
        assisted && snapshot !== undefined
          ? rulesVersionForLoadSemantics(exercise.loadSemantics, snapshot.rulesVersion)
          : rulesVersionForLoadSemantics(exercise.loadSemantics, RULES_VERSION),
    });
  }

  toApi(exerciseId: string, sets: number, recommendation: Recommendation): ApiRecommendation {
    return {
      exercise_id: exerciseId,
      // 맨몸·시간 종목은 weight=null, 시간 종목은 반복 축이 없어 reps_*=null 이다(openapi nullable).
      weight: recommendation.weight,
      reps_low: recommendation.reps_low ?? null,
      reps_high: recommendation.reps_high ?? null,
      sets,
      ...(recommendation.time_low_sec === undefined
        ? {}
        : { time_low_sec: recommendation.time_low_sec }),
      ...(recommendation.time_high_sec === undefined
        ? {}
        : { time_high_sec: recommendation.time_high_sec }),
      reason_code: recommendation.reason_code,
      confidence: recommendation.confidence,
      explanation: explanationFor(
        recommendation.reason_code,
        recommendation.recommendation_state,
        recommendation.load_kind,
      ),
      rules_version: recommendation.rules_version,
      load_kind: recommendation.load_kind,
      recommendation_state: recommendation.recommendation_state,
      recommended_action: recommendation.recommended_action ?? null,
    };
  }

  /** Persisted planned-set recommendation → public contract, without re-running the engine. */
  plannedToApi(
    exerciseId: string,
    sets: number,
    planned: {
      recommendedWeight: { toString(): string } | null;
      recommendedReps: number | null;
      targetRepsLow: number | null;
      targetRepsHigh: number | null;
      targetTimeLowSec: number | null;
      targetTimeHighSec: number | null;
      reasonCode: string;
      confidence: { toString(): string };
      rulesVersion: string;
      loadSemantics?: "assistance" | "external_load";
    },
  ): ApiRecommendation {
    const reason = planned.reasonCode as ReasonCode;
    const weight = planned.recommendedWeight === null ? null : Number(planned.recommendedWeight);
    const loadKind = loadKindFor(planned.loadSemantics ?? "external_load", planned, weight);
    const state = stateForReason(reason);
    return {
      exercise_id: exerciseId,
      weight,
      reps_low: planned.recommendedReps,
      reps_high: planned.targetRepsHigh,
      sets,
      ...(planned.targetTimeLowSec === null ? {} : { time_low_sec: planned.targetTimeLowSec }),
      ...(planned.targetTimeHighSec === null ? {} : { time_high_sec: planned.targetTimeHighSec }),
      reason_code: planned.reasonCode,
      confidence: Number(planned.confidence),
      explanation:
        EXPLANATION[reason] === undefined
          ? "최근 완료 기록을 반영한 다음 세션 추천이다."
          : explanationFor(reason, state, loadKind),
      rules_version: planned.rulesVersion,
      load_kind: loadKind,
      recommendation_state: state,
      recommended_action:
        reason === "ASSISTANCE_MINIMUM_REACHED"
          ? { kind: "suggest_exercise_swap", exercise_id: "e_pullup" }
          : null,
    };
  }
}

/** 저장 행에서 부하 축의 의미를 되살린다. snapshot 이 원천이고 카탈로그를 다시 읽지 않는다. */
function loadKindFor(
  loadSemantics: "assistance" | "external_load",
  planned: { targetTimeHighSec: number | null },
  weight: number | null,
): LoadKind {
  if (loadSemantics === "assistance") return "assistance";
  if (planned.targetTimeHighSec !== null) return "not_applicable";
  return weight === null ? "bodyweight" : "external";
}

/** reason → 상태. 저장 행에는 상태 컬럼이 없어 reason 이 유일한 원천이다. */
function stateForReason(reason: ReasonCode): RecommendationState {
  if (reason === "SUBSTITUTE_PAIN") return "substitution_required";
  if (reason === "INVALID_INPUT") return "unavailable";
  if (reason === "ASSISTANCE_CALIBRATION_NEEDED" || reason === "LOAD_CALIBRATION_NEEDED")
    return "load_calibration_needed";
  return "ready";
}

/** 암호문 → 숫자 복호화는 서비스 레이어(여기)에서만 한다. repository/prisma 는 string|null 만 다룬다. */
export function toHistory(
  rows: {
    actualWeight: { toString(): string } | null;
    actualReps: number | null;
    actualRir: number | null;
    actualTimeSec: number | null;
    painScore: string | null;
  }[],
): ExerciseHistory {
  // metric=reps 는 w/reps(+rir), metric=time 은 time_sec 만 채운다(엔진 PerformedSet).
  const lastSets = rows.map((row) => ({
    ...(row.actualWeight === null ? {} : { w: Number(row.actualWeight) }),
    ...(row.actualReps === null ? {} : { reps: row.actualReps }),
    ...(row.actualRir === null ? {} : { rir: row.actualRir }),
    ...(row.actualTimeSec === null ? {} : { time_sec: row.actualTimeSec }),
  }));
  // 복호화는 adapter 가 한다. 여기서 throw 시키면 손상된 행 하나가 요청 전체를 500 으로 만든다.
  const pain = mergePainObservations(rows.map((row) => readPainObservation(row.painScore)));

  return pain.kind === "missing" ? { lastSets } : { lastSets, pain };
}

/**
 * tagged 관측값 → 엔진 입력. **어느 종목이든 같은 fail-closed 의미**를 적용한다 —
 * 어시스트 전용 규칙이 아니라 안전 경계다(F fixup-01 항목 7).
 */
export function safetyInputFor(
  pain: PainObservation | undefined,
): Pick<RecommendationInput, "safety"> | Record<string, never> {
  if (pain === undefined || pain.kind === "missing") return {};
  return pain.kind === "value"
    ? { safety: { pain_score: pain.value } }
    : { safety: { pain_failure_code: pain.failure_code } };
}

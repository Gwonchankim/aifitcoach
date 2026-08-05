-- 맨몸(자체중량) 종목은 추가 부하를 처방하지 않는다 → recommended_weight NULL 허용.
-- metric=time 종목(e_plank)은 반복·RIR 축이 없다 → 반복 목표 NULL 허용 + 시간 목표 컬럼 추가.
-- NOT NULL 완화라 기존 행은 그대로 유효하다(백필 불필요).
-- AlterTable
ALTER TABLE "planned_sets"
  ALTER COLUMN "target_reps_low" DROP NOT NULL,
  ALTER COLUMN "target_reps_high" DROP NOT NULL,
  ALTER COLUMN "target_rir" DROP NOT NULL,
  ALTER COLUMN "recommended_weight" DROP NOT NULL,
  ALTER COLUMN "recommended_reps" DROP NOT NULL,
  ADD COLUMN "target_time_low_sec" INTEGER,
  ADD COLUMN "target_time_high_sec" INTEGER;

-- metric=time 종목은 무게·반복 대신 유지 시간을 기록한다(서로 배타적이라 양쪽 NULL 허용).
-- AlterTable
ALTER TABLE "performed_sets"
  ALTER COLUMN "actual_weight" DROP NOT NULL,
  ALTER COLUMN "actual_reps" DROP NOT NULL,
  ADD COLUMN "actual_time_sec" INTEGER;

-- pain_areas 제외 근거(openapi Program.excluded_exercises)를 생성 시점 값으로 고정 저장한다.
-- AlterTable
ALTER TABLE "programs" ADD COLUMN "excluded_exercises" JSONB NOT NULL DEFAULT '[]';

-- 한 세션에 같은 exercise_id 를 두 번 넣지 못하게 DB 에서 막는다(앱 레벨 가드는 유지).
-- planned_sets 는 "세트 1행"이라 (session_id, exercise_id) 만으로는 유니크가 될 수 없다
-- (한 운동당 set_no 1..N 행) → set_no 를 포함한다. 동시 추가는 항상 set_no=1 에서 충돌한다.
-- CreateIndex
CREATE UNIQUE INDEX "ux_planned_session_exercise_set" ON "planned_sets"("session_id", "exercise_id", "set_no");

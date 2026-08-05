-- 즉석 세션(F8-1)을 계획 세션과 구분한다. 계획에 없던 운동을 "더 하려고 만든" 세션이
-- 미완료로 남았다고 스트릭·주간 완료율을 깎으면 안 된다(대시보드 결함 D-1).
-- 기존 행은 모두 프로그램 생성이 펼친 계획 세션이므로 DEFAULT 로 백필된다.

-- CreateEnum
CREATE TYPE "session_origin" AS ENUM ('planned', 'ad_hoc');

-- AlterTable
ALTER TABLE "workout_sessions" ADD COLUMN "origin" "session_origin" NOT NULL DEFAULT 'planned';

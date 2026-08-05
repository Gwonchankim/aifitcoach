-- 핫패스 인덱스(docs/DATA_MODEL.md "인덱스" 절). 최종 평가 EXPLAIN 에서 두 테이블이 Seq Scan 이었다.
-- performed_sets 는 앱에서 가장 빨리 커지는 테이블이고, 조회는 항상 planned_set_id 를 통해 들어온다
--   (recommendation.historyFor / sessions.complete / 루틴 편집의 수행기록 가드).
-- CreateIndex
CREATE INDEX "ix_performed_planned" ON "performed_sets"("planned_set_id");

-- programs 는 user_id 로만 조회한다(programs.current). 테넌시 경계라 모든 요청이 지나간다.
-- CreateIndex
CREATE INDEX "ix_programs_user" ON "programs"("user_id");

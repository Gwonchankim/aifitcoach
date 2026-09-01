-- F-3 fixup — remediation 처방 교정 · exact provenance/version matrix · snapshot immutability.
--
-- 이미 적용된 `20260827120000_f3_assistance_semantics` 는 **한 글자도 고치지 않는다.**
-- 여기는 additive forward-fix 다(destructive down migration 금지 정책 그대로).
--
-- 순서가 계약이다: preflight → correction → exact CHECK → immutability trigger.
--   * preflight 를 먼저 하지 않으면 unknown 버전 행이 CHECK 단계에서야 터져
--     "무엇이 왜 막혔는지" 없이 migration 이 실패한다.
--   * correction 을 CHECK 보다 먼저 하지 않으면 기존 행이 조건을 못 맞춰 CHECK 자체가 걸리지 않는다.
--   * trigger 를 correction 보다 먼저 걸면 correction 의 provenance UPDATE 를 trigger 가 막는다.
--
-- **수행된 행(performed fact)의 값을 바꾸지 않는다.** `legacy_performed` 는 `.08.1` 그대로 둔다.
-- **통증(pain_score)을 읽지 않는다.**

-- ------------------------------------------------------------- 1) preflight
-- 어시스트 행에 지원하지 않는 rules_version 이 있으면 **계산 전에 멈춘다**(fail closed).
-- 조용히 native 로 분류하면 나중에 그 행을 어느 규칙으로 읽어야 하는지 알 수 없게 된다.
DO $$
DECLARE unknown_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO unknown_count
    FROM "planned_sets"
   WHERE "assistance_provenance" IS NOT NULL
     AND "rules_version" NOT IN ('2026.08.1', '2026.08.2', '2026.09.0', '2026.09.1');
  IF unknown_count > 0 THEN
    RAISE EXCEPTION
      '어시스트 planned_sets 에 지원하지 않는 rules_version 이 % 건 있다. 지원 버전: 2026.08.1, 2026.08.2, 2026.09.0, 2026.09.1',
      unknown_count;
  END IF;
END $$;

-- ----------------------------------------------------------- 2) correction
-- (a) F-3 적용 이후 factory 가 만든 `.08.1/native` 행을 원래 규칙으로 재분류한다.
--     `.08.1` 엔진은 어시스트 의미를 모르므로 그 출력에 native 를 붙일 수 없다.
--     수행된 행은 `.08.1` 을 유지한 채 legacy_performed 로만 바꾼다(사실 보존).
UPDATE "planned_sets" ps
   SET "assistance_provenance" = 'legacy_performed'::"assistance_provenance"
 WHERE ps."assistance_provenance" = 'native'
   AND ps."rules_version" = '2026.08.1'
   AND EXISTS (SELECT 1 FROM "performed_sets" pf WHERE pf."planned_set_id" = ps."id");

UPDATE "planned_sets" ps
   SET "assistance_provenance" = 'remediated'::"assistance_provenance",
       "rules_version" = '2026.08.2'
 WHERE ps."assistance_provenance" = 'native'
   AND ps."rules_version" = '2026.08.1'
   AND NOT EXISTS (SELECT 1 FROM "performed_sets" pf WHERE pf."planned_set_id" = ps."id");

-- (b) remediated 행의 **처방 자체**를 교정한다. 앞 migration 은 rules_version 만 올려서
--     `.08.1` 일반 가중 처방(stale weight + 일반 reason)이 그대로 남아 있었다.
--     도움 kg 은 기계마다 달라 발명할 수 없다 → 무게 미정 + 캘리브레이션 요청이 정답이다.
UPDATE "planned_sets"
   SET "recommended_weight" = NULL,
       "reason_code" = 'ASSISTANCE_CALIBRATION_NEEDED',
       "confidence" = 0
 WHERE "assistance_provenance" = 'remediated';

-- (c) 재분류로 새로 생긴 provenance 에도 audit 를 남긴다. 멱등이다.
INSERT INTO "assistance_audits" ("id", "planned_set_id", "action", "metadata")
SELECT gen_random_uuid(), ps."id", ps."assistance_provenance"::text, '{}'::jsonb
  FROM "planned_sets" ps
 WHERE ps."assistance_provenance" IS NOT NULL
ON CONFLICT ("planned_set_id", "action") DO NOTHING;

-- ----------------------------------------------------- 3) exact matrix CHECK
-- provenance ↔ rules_version 을 정확히 잠근다. 앞 CHECK 는 load_semantics 와 nullable 짝만 봐서
-- `.08.1/native`, `.09/legacy_performed` 같은 조합을 허용했다.
-- 목록 밖 문자열은 어느 분기도 만족하지 못하므로 **unknown 은 여기서도 fail closed** 다.
-- packages/shared 의 ASSISTANCE_PROVENANCE_VERSIONS 와 같은 집합이어야 한다.
ALTER TABLE "planned_sets"
  ADD CONSTRAINT "ck_planned_assistance_version_matrix"
  CHECK (
    "assistance_provenance" IS NULL
    OR ("assistance_provenance" = 'native'
        AND "rules_version" IN ('2026.08.2', '2026.09.0', '2026.09.1'))
    OR ("assistance_provenance" = 'remediated'
        AND "rules_version" = '2026.08.2')
    OR ("assistance_provenance" = 'legacy_performed'
        AND "rules_version" = '2026.08.1')
  );

-- ------------------------------------------------ 4) immutability trigger
-- 생성 시점에 굳힌 snapshot 3축은 **valid → valid 변경도 거부한다.**
-- 지금 production caller 가 우연히 건드리지 않는 것은 불변성 강제가 아니다.
--
-- `rules_version` 은 여기 없다 — F6-1 재계산과 V2 activation pointer flip 이 갱신하는
-- recommendation provenance 다. 대신 위 matrix CHECK 가 바뀐 뒤의 조합을 검증한다.
CREATE OR REPLACE FUNCTION "afc_planned_assistance_snapshot_immutable"()
RETURNS trigger AS $$
BEGIN
  IF NEW."load_semantics" IS DISTINCT FROM OLD."load_semantics"
     OR NEW."assistance_step_kg" IS DISTINCT FROM OLD."assistance_step_kg"
     OR NEW."assistance_provenance" IS DISTINCT FROM OLD."assistance_provenance" THEN
    RAISE EXCEPTION
      'planned_sets 의 어시스트 snapshot(load_semantics, assistance_step_kg, assistance_provenance)은 불변이다.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_planned_assistance_snapshot_immutable"
  BEFORE UPDATE ON "planned_sets"
  FOR EACH ROW
  EXECUTE FUNCTION "afc_planned_assistance_snapshot_immutable"();

-- ----------------------------------------------------------------- rollback
--
-- 앞 migration 과 같은 정책이다. **destructive down migration 을 만들지 않는다.**
-- 허용되는 것은 additive schema 를 유지한 compatibility rollback 과 후속 forward-fix 뿐이다.
--
-- 보존 대상(되돌리지 않는다):
--   - `assistance_audits` 전체 — 감사 근거다.
--   - remediated 행의 `.08.2` + null weight + ASSISTANCE_CALIBRATION_NEEDED —
--     되돌리면 도움 kg 을 일반 가중으로 읽는 틀린 처방이 다시 살아난다.
--   - `legacy_performed` 행의 `.08.1` 과 performed fact — 사실 그대로다.

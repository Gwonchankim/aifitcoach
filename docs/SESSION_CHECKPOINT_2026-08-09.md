# 세션 체크포인트 — 2026-08-09

> 이 파일 하나로 다음 세션이 맥락 없이 재개할 수 있어야 한다. 추측 없이 **실측한 값만** 적었다.

## 1. 저장소 상태

| | |
| --- | --- |
| 브랜치 | `master` (원격 PR 없음, worktree 1개: `C:/Users/amole/Desktop/aifitcoach`) |
| HEAD | **`9f457eb`** |
| 워킹트리 | clean |

### 오늘의 커밋 체인

```
d3b16ff  feat(web)     M-UIa Sprint 1 — 디자인 토큰 라이트 팔레트 교체 + 폰트 셀프호스팅
48390c1  feat(web,ci)  M-UIa Phase B — 공용 UI 리스킨(Sprint 2) + 토큰 대비 CI 검사(Sprint 6)
c347b06  feat(web)     M-UIa Phase C — 세션·대시보드·프로그램·온보딩 리스킨 + 홈 빈 상태 신설
718d88d  fix(web,docs) M-UIa Step 4 — evaluator 지적 fix-now 5건 + 스코어카드 기록
d711dec  fix(test)     삭제된 axe-results.jsonl 복구 — 부분 실행 + git add -A 함정
9f457eb  feat(web,ci)  F1 "파랑=상태, ink=액션" 확정(ADR-52) + F2 판단 + CI E2E + 성능 실측
```

그 앞: `b47d0f2`(테스트 격리 마일스톤 완료 기록) · `24790cf`(M-UIa 착수 계획) — **UIa 이전 기준선은 `24790cf`** 다.

## 2. M-UIa — 완료

`/orchestration` 으로 6개 Sprint 를 3 Phase 에 배치(Run `run_446a6e69bf65`).

| Phase | Sprint | 결과 |
| --- | --- | --- |
| A | 1 토큰·폰트 | 라이트 팔레트 + 신설 토큰 16종, Tailwind `@theme` 텍스트 스케일 재정의(컴포넌트 수정 없이 적용), Pretendard·JetBrains Mono 셀프호스팅 |
| B | 2 공용 UI ∥ 6 대비 CI | 모노 숫자·소프트 배지·그림자 제거 / `verify:contrast` 신설 + CI 연결 |
| C | 3 세션 ∥ 4 대시보드·프로그램 ∥ 5 온보딩 | 화면 리스킨 + **홈 빈 상태 신설**(D-5) |

**Step 4 평가**: evaluator **71/100 CONDITIONAL PASS**(하드 게이트 전부 PASS) → fix-now 5건 처리 → **F1·F2 완료**.

- **F1** 주 CTA 를 ink 로(**ADR-52** "파랑 = 상태/정보, ink = 액션"). 역할 토큰 `--afc-action` 신설.
- **F2** 칩·배지 `rounded-full` → `rounded-control`(2px). §5 가 명확해 해석 여지 없이 닫았다.
- F3 빈 상태 회귀 그물 + axe 스캔 신설 / F4 뮤테이션 스냅샷 무언 롤백 차단 / F5 ADR-51 방향 오류 정정 / F6 대비 반올림 구멍.

> **evaluator 지적 중 정정한 것**: F1·F2 를 UIa 산출물로 봤으나 `git show 24790cf` 로 확인하니
> `bg-primary`·`rounded-full` 은 **UIa 이전부터 있었다** — UIa 가 만든 회귀가 아니라 **닫지 않은 divergence** 다.

## 3. 게이트 (HEAD 기준 실측)

```
typecheck · lint · format:check · build · verify:no-test-seed · verify:contrast(30조합)   전부 green
shared 79 · web 224 · api 237 · E2E 55/55 · axe 19화면 위반 0
```

## 4. 예측 검증 — 맞았다

착수 계획에서 **"E2E 54개 중 손대는 테스트 최대 1건"** 이라고 예측했다.

| Phase | 손댄 테스트 |
| --- | --- |
| A 토큰·폰트 | **0** |
| B 공용 UI + 대비 CI | **0** |
| C 화면 3종 + 빈 상태 | **1** (`01-…:108` 빈 상태 문구 — 예측한 바로 그 건) |

치수를 UIb 로 미룬 **D-3 판단이 결정적**이었다. 터치 타깃을 건드렸다면 `06-mobile` 이 즉시 깨졌다
(완료 체크 `min(w,h) >= 48` 인데 확정안은 48×44 → 44).

## 5. 🔴 UIb 착수 전 선행 3건

| # | 티켓 | 왜 선행인가 | 상태 |
| --- | --- | --- | --- |
| **T-UI-1** | `cn` → tailwind-merge | `cn` 이 단순 join 이라 클래스 충돌이 **CSS 순서**로 갈린다(실제로 `rounded-card` 가 `rounded-full` 에 져서 목표·경력 카드가 알약이었다). 지금 `!` 4곳으로 우회 중. UIb 가 만들 새 variant 들이 같은 충돌을 다시 밟고, `!` 는 규모가 커지면 못 버틴다. **횡단 변경이라 UIb 와 섞으면 시각 회귀 원인을 못 가린다** | 착수 대기 |
| **T-UI-2** | 폰트 페이로드 | **성능 회귀 실측: desktop-dashboard 100(08-05) → 92(08-09).** Pretendard 4웨이트 × 262KB = **1,051KB** 가 전부 내려온다(페이지 1,200KiB). `preload:false` 는 이미 걸려 있고 화면이 4웨이트를 실제로 쓴다 → **서브셋 크기** 문제다. UIb 가 이 위에 쌓이면 이후 성능 변화의 원인을 못 가린다 | 착수 대기 |
| **F14** | 한글 키커 대체 어법 | 프로토타입의 지배적 모티프인 키커가 **7파일 139회**인데 구현은 **3곳**만 쓴다. 9.5px 모노 + `.14em` 자간을 한글에 못 쓰는 게 근본 원인이고, **한글 대체 어법이 설계되지 않았다.** "리스킨했는데 프로토타입처럼 안 보이는" 구조적 이유다 | **오너 결정 대기** (design 협업 필요) |

### T-UI-2 해법 후보 (오너 판단이 필요할 수 있음)
- **① `unicode-range` 동적 서브셋** — 정공법. Pretendard 가 공식 제공하고 통상 30~80KB 로 떨어진다.
  지금 못 한 이유: 패키지를 안 쓰고 woff2 를 직접 받아 둔 구조라 **서브셋 파일 100여 개를 새로 조달**해야 한다.
- ② 웨이트 4→2 축소 — 약 524KB 절감. 단 `font-semibold`(28곳)·`font-medium`(10곳)이 인접 웨이트로 스냅돼
  **디자인 충실도와 상충**한다. F1 에서 충실도를 택한 직후라 임의로 정하지 않았다.

## 6. 미확인 항목

| 항목 | 상태 |
| --- | --- |
| **GitHub Actions 실제 실행** | CI 에 E2E 를 추가했지만 **워크플로를 돌려보지 못했다.** 첫 PR 에서 확인해야 한다. 로컬에서 확인한 것: YAML 파싱(16스텝) · `FIELD_ENCRYPTION_KEY` 플레이스홀더가 정확히 **32바이트**(처음 넣은 값은 34바이트라 API 가 부팅에 실패했을 것이다) · env 만으로 `afc_test → afc_test_e2e` 파생 |
| **CI 추가 시간** | **+4~6분 예상**(playwright 브라우저 설치 + E2E 1.3분). 실측 아님 |
| 동시 E2E 실행 | 여전히 불가(`apps/api/dist` 공유). **조용한 오염이 아니라 시끄러운 실패**라 STEP 6 의 "중복·유실 0" 단언을 위협하지 않는다 |

## 7. 이번 마일스톤의 교훈

1. **뮤테이션은 "실패했는가" 전에 "주입됐는가"를 본다.**
   RIR 테스트 뮤턴트 M3 이 "살아남았다"고 판단했는데, 실제로는 `sed` 가 `aria-pressed=` 를 찾았지만
   소스는 `selected=` 였다 — **뮤턴트가 주입조차 안 됐다.** sha256 전후 비교를 넣고 다시 돌리니 사살됐다.
   가짜 생존은 "테스트가 약하다"는 잘못된 결론으로 이어진다.

2. **명세로 막은 것이 두 번 뚫렸다 — 규칙은 문서가 아니라 도구로 막아야 한다.**
   - `git stash` 금지를 Phase C 명세에 적었지만, 그 전에 Sprint 2 가 이미 공유 워크트리에서 stash 를 썼다
     (다른 Sprint 의 미커밋 변경이 함께 흔들렸다. 복구는 됐다).
   - evaluator 가 F8 로 "부분 E2E 실행 + `git add -A` → 커밋된 산출물 삭제"를 경고했는데,
     **그 경고를 읽은 직후에 내가 그대로 밟아** `axe-results.jsonl` 을 지운 채 커밋했다(`d711dec` 로 복구).
   → 두 사고 다 "하지 마라"로는 못 막았다. `mutate.mjs` 의 인자 없는 `restore` 차단처럼 **도구가 거절**해야 한다.

3. **"설계상 그렇다"를 산출물로 확인한다.** `NEXT_PUBLIC_*` 시드가 "값을 안 주면 안 남는다"는 판단이 틀렸고
   (클라이언트 청크에 런타임 조회가 남았다), `success-bg` 가 "밝히면 깨진다"는 서술도 방향이 반대였다.
   둘 다 실측이 반증했다. → `verify:no-test-seed`, `verify:contrast` 가 그 자리를 대신한다.

4. **자동 게이트의 사각지대는 별도 그물이 필요하다.** 주 CTA 를 파랑으로 되돌려도 대비(ink 17.48 / 파랑 7.09)와
   axe 는 **둘 다 통과한다.** `test/action-color.test.ts` 로 규칙 자체를 고정하고 뮤테이션으로 발화를 확인했다.

## 8. 환경 상태

**Docker**: `scripts-postgres-1`(healthy) · `scripts-redis-1` — 5시간째 기동 중. 포트 3000·3001·3101 **전부 비어 있음**.

| DB | 상태 | 비고 |
| --- | --- | --- |
| `afc` (개발) | exercises 30 / users 1 / programs 0 / sessions 0 | **`pnpm db:reset` 으로 초기화됨.** users 1 은 dev-user(`…0001`) 자동 프로비저닝. **빈 상태 화면 재현 가능** |
| `afc_test` (api 통합) | exercises 30 / users 1 / programs 0 / sessions 0 | 남은 users 1 은 실행 단위 UUID(`87b0e27e…`) — 중간에 죽은 실행의 잔여다. globalTeardown 은 best-effort 라 강제 종료된 실행은 정리되지 않는다. 무해(다음 실행은 새 UUID) |
| `afc_e2e` (E2E 전용) | exercises 30 / users 15 / programs 262 / sessions 1,560 | **E2E 에는 teardown 이 없다** — 실행마다 새 사용자로 쌓인다. 개발 DB 와 분리돼 있어 무해하고, `pnpm db:reset`(볼륨 삭제)이 함께 비운다 |

`.mutation-snapshot/` 비어 있음(clear 완료).

빈 상태 재현 확인:
- 대시보드 → "아직 운동 계획이 없어요" + "만들고 나면" 3단 (`GET /programs/current` → 404)
- 첫 세션 → "무게 미정 / 첫 세션이라 추천 무게가 아직 없어요"
- `/analytics` 3종 → 501 (기록 탭 = M-4′ 가 쓸 자리)

## 9. 내일 재개 체크리스트 (순서대로)

1. `git log --oneline -6` 으로 HEAD 가 **`9f457eb`** 인지 확인. 워킹트리 clean 확인.
2. Docker Desktop 실행 → `pnpm db:up` (컨테이너가 내려가 있으면).
3. 게이트로 기준선 재확인: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm test`
   그리고 `pnpm --filter web verify:contrast`, `pnpm --filter web verify:no-test-seed`.
4. E2E 기준선: `pnpm --filter web test:e2e` (API·웹을 스스로 띄운다. **55/55 · axe 19화면 0** 이어야 한다).
5. **T-UI-1(`cn` → tailwind-merge)** 착수 — UIb 선행. 완료 기준은 §5 표 참조.
6. **T-UI-2(폰트 페이로드)** 착수 — 해법 ①/② 중 오너 판단이 필요하면 먼저 물어라(성능 92 → 100 회복이 목표).
7. **F14(한글 키커 어법)** 는 **오너 결정 대기**다. 임의로 정하지 말고 선택지와 근거를 제시하라.
8. 위 3건이 닫히면 **M-UIb** 착수(세트 행 3열 인라인 편집 · ⋯ 단일 메뉴 · RIR 게이지 · 치수/터치 타깃).

## 10. 로드맵 현재 위치

```
[테스트 격리 + E2E 요일] ✅ → M-UIa ✅ → [T-UI-1 · T-UI-2 선행] ← 지금 여기
   → M-UIb → STEP 6(오프라인 동기화) → M-4′(기록·프로그램 탭) → M-7′(페이월·구독)
```

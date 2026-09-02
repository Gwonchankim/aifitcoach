/* global process, console, URL */
/**
 * T2(휴식 타이머 지속·복구) 뮤테이션 표.
 *
 * "테스트가 통과한다"를 믿지 않는다. 핵심 분기를 하나씩 고의로 망가뜨려 **어떤 테스트가 잡는지**
 * 기록하고, 매번 원복해 sha256 으로 대조한다(CLAUDE.md 함정 5).
 *
 *   node scripts/mutation-t2.mjs            전체
 *   node scripts/mutation-t2.mjs --self-test 러너가 실패를 실제로 감지하는지만 확인
 *
 * ## 이 러너가 과거에 틀렸던 방식 — 전부 여기서 막는다
 *
 * 1. **`pnpm.cmd` 직접 spawn.** Windows 에서 `.cmd` 를 `shell: false` 로 띄우면 `EINVAL` 이라
 *    명령이 돌지도 않았는데 예외가 나서 **전부 거짓 RED** 가 됐다. → JS 진입점을 `node` 로 띄우고,
 *    출력이 비면 `SpawnError` 로 구분해 중단한다.
 * 2. **문법 오류로 죽은 RED.** `catch` 만 지우면 `try` 가 짝을 잃는다. 파서가 잡은 것을 테스트
 *    방어력으로 세면 안 된다. → 블록 통째 교체 + `INVALID_RED` 판별.
 * 3. **런타임 `SyntaxError` 오탐.** JSON 파싱 격리를 지우면 테스트가 런타임 `SyntaxError` 를
 *    잡는데, 그걸 "파일이 안 읽혔다"로 오인해 무효 처리했다. → 로드 실패 문구로만 좁힌다.
 * 4. **오염된 baseline.** 이미 더러운 트리에서 시작하면 원복이 무엇으로 되돌리는지 알 수 없다.
 *    → 시작 전에 대상 파일이 clean 한지 확인하고, 아니면 아무것도 하지 않고 중단한다.
 * 5. **중단 시 뮤테이션 잔류.** 예외가 나면 망가진 파일이 그대로 남았다. → `finally` 로 원복하고,
 *    끝에서 sha256 과 `git status` 를 모두 확인한다. 테스트가 만드는 추적 산출물
 *    (`e2e/axe-results.jsonl` 등)도 잔류 검사에 포함한다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIR = join(ROOT, "apps", "web");
const STORE = join(WEB_DIR, "components", "session", "rest-timer-store.ts");
const NOTIFY = join(WEB_DIR, "lib", "rest-notification.ts");
const SHEET = join(WEB_DIR, "components", "session", "RestTimerSheet.tsx");
const SCREEN = join(WEB_DIR, "components", "session", "SessionScreen.tsx");
const COORDINATOR = join(WEB_DIR, "components", "session", "sync-coordinator.ts");

/** ANSI 이스케이프의 시작 바이트. 소스에 제어문자를 남기지 않으려고 코드로 만든다. */
const ESC = String.fromCharCode(27);

const NAMES = new Map([
  [STORE, "rest-timer-store.ts"],
  [NOTIFY, "rest-notification.ts"],
  [SHEET, "RestTimerSheet.tsx"],
  [SCREEN, "SessionScreen.tsx"],
  [COORDINATOR, "sync-coordinator.ts"],
]);

const MUTATIONS = [
  /* ---- 레코드 검증 ---- */
  {
    id: 1,
    file: STORE,
    what: "레코드 버전 확인 제거 — 모르는 모양을 읽는다",
    from: "if (record.v !== REST_TIMER_RECORD_VERSION) return null;",
    to: "if (record.v === undefined && false) return null;",
  },
  {
    id: 2,
    file: STORE,
    what: "session_id 대조 제거 — 남의 세션 타이머를 올린다",
    from: "if (!isNonEmptyString(record.session_id) || record.session_id !== sessionId) return null;",
    to: "if (!isNonEmptyString(record.session_id)) return null;",
  },
  {
    id: 3,
    file: STORE,
    what: "ends_at 검증 제거 — 문자열·0·NaN 도 통과",
    from: "if (!isPositiveInt(record.ends_at)) return null;",
    to: "if (record.ends_at === undefined) return null;",
  },
  {
    id: 4,
    file: STORE,
    what: "**정상 연장 타이머를 다시 거절** — total_sec 에 600 상한을 되돌린다",
    from: "  if (!isPositiveInt(record.total_sec)) return null;",
    to: "  if (!isPositiveInt(record.total_sec) || record.total_sec > 600) return null;",
  },
  {
    id: 5,
    file: STORE,
    what: "total_sec 안전정수 확인을 느슨하게 — NaN·소수 통과",
    from: '  typeof value === "number" && Number.isSafeInteger(value) && value > 0;',
    to: '  typeof value === "number" && value > 0;',
  },
  {
    id: 6,
    file: STORE,
    what: "planned_set_id 검증 제거",
    from: "if (!isNonEmptyString(record.planned_set_id)) return null;",
    to: "if (record.planned_set_id === undefined) return null;",
  },
  {
    id: 7,
    file: STORE,
    what: "stale 판정 부호 뒤집기",
    from: "return now >= record.ends_at + REST_TIMER_STALE_AFTER_MS;",
    to: "return now < record.ends_at + REST_TIMER_STALE_AFTER_MS;",
  },
  {
    id: 8,
    file: STORE,
    what: "stale 경계를 하루로 늘림",
    from: "export const REST_TIMER_STALE_AFTER_MS = REST_MAX_SEC * 1000;",
    to: "export const REST_TIMER_STALE_AFTER_MS = 86_400_000;",
  },
  {
    id: 9,
    file: STORE,
    what: "stale 검사를 복구 경로에서 빼기",
    from: "if (!record || isStaleRestTimer(record, now)) {",
    to: "if (!record) {",
  },
  {
    id: 10,
    file: STORE,
    what: "JSON 파싱 실패 격리 제거",
    edits: [
      [
        "  try {\n    parsed = JSON.parse(raw);\n  } catch {\n    return null;\n  }",
        "  parsed = JSON.parse(raw);",
      ],
    ],
  },

  /* ---- 큐·순서 ---- */
  {
    id: 11,
    file: STORE,
    what: "save 를 큐 밖으로 — 늦은 save 가 clear 를 앞지른다",
    edits: [
      [
        "  return enqueue(restTimerKeyFor(sessionId), async () => {\n    // **쓰기 직전에**",
        "  return (async () => {\n    // **쓰기 직전에**",
      ],
      ["      return false;\n    }\n  });\n}", "      return false;\n    }\n  })();\n}"],
    ],
  },
  {
    id: 12,
    file: STORE,
    what: "clear 를 큐 밖으로",
    from: "  return enqueue(restTimerKeyFor(sessionId), () => rawDelete(userId, sessionId));",
    to: "  return rawDelete(userId, sessionId);",
  },
  {
    id: 13,
    file: STORE,
    what: "큐를 전역 하나로 — 다른 세션이 서로를 막는다",
    from: "const previous = writeQueues.get(key) ?? Promise.resolve();",
    to: 'const previous = writeQueues.get("all") ?? Promise.resolve();',
  },
  {
    id: 14,
    file: STORE,
    what: "큐 찌꺼기 정리 제거",
    from: "    if (writeQueues.get(key) === settled) writeQueues.delete(key);",
    to: "    /* 정리하지 않는다 */",
  },
  {
    id: 15,
    file: STORE,
    what: "**load 를 큐 밖으로** — 낡은 판정의 삭제가 새 save 를 지운다",
    edits: [
      [
        "  return enqueue(restTimerKeyFor(sessionId), async () => {\n    const raw = await rawRead(userId, sessionId);\n    if (raw === undefined) return null;",
        "  return (async () => {\n    const raw = await rawRead(userId, sessionId);\n    if (raw === undefined) return null;",
      ],
      [
        "      timer: { totalSec: record.total_sec, endsAt: record.ends_at },\n    };\n  });\n}",
        "      timer: { totalSec: record.total_sec, endsAt: record.ends_at },\n    };\n  })();\n}",
      ],
    ],
  },
  {
    id: 16,
    file: STORE,
    what: "load 의 compare-and-delete 를 무조건 삭제로",
    from: "      if ((await rawRead(userId, sessionId)) === raw) await rawDelete(userId, sessionId);",
    to: "      await rawDelete(userId, sessionId);",
  },

  /* ---- 세트 정체성 ---- */
  {
    id: 17,
    file: STORE,
    what: "완료 취소가 **다른 세트** 타이머까지 지우게 만들기",
    from: "    if (record !== null && record.planned_set_id !== plannedSetId) return true;",
    to: "    if (false) return true;",
  },
  {
    id: 18,
    file: STORE,
    what: "승격이 다른 세트 레코드까지 덮어쓰게 만들기",
    from: "    if (record === null || record.planned_set_id !== fromPlannedSetId) return false;",
    to: "    if (record === null) return false;",
  },
  {
    id: 19,
    file: STORE,
    what: "승격을 큐 밖으로 — 앞선 save 를 앞지른다",
    edits: [
      [
        "  return enqueue(restTimerKeyFor(sessionId), async () => {\n    const raw = await rawRead(userId, sessionId);\n    if (raw === undefined) return false;",
        "  return (async () => {\n    const raw = await rawRead(userId, sessionId);\n    if (raw === undefined) return false;",
      ],
      ["      return false;\n    }\n  });\n}", "      return false;\n    }\n  })();\n}"],
    ],
  },

  /* ---- 복구 세대 ---- */
  {
    id: 20,
    file: STORE,
    what: "세대를 버리고 세션 문자열로만 판정 — A→B→A 에서 옛 표가 되살아난다",
    from: "      return current !== null && current.generation === token.generation;",
    to: "      return current !== null && current.sessionId === token.sessionId;",
  },
  {
    id: 21,
    file: STORE,
    what: "invalidate 가 세대를 올리지 않게 만들기",
    from: "      generation += 1;\n      current = null;",
    to: "      current = null;",
  },
  {
    id: 22,
    file: STORE,
    what: "begin 을 세션 무관 1회 플래그로 — 다음 세션을 영구 skip",
    from: "      if (current !== null && current.sessionId === sessionId) return null;",
    to: "      if (current !== null) return null;",
  },
  {
    id: 23,
    file: STORE,
    what: "복구 적용 전 표 확인 제거",
    from: "  if (!coordinator.isCurrent(token) || !stored) return;",
    to: "  if (!stored) return;",
  },
  {
    id: 24,
    file: STORE,
    what: "복구 시 자격 확인 제거 — 무엇이든 올린다",
    from: "  if (!isRestorable(eligibility, stored.plannedSetId)) {",
    to: "  if (false) {",
  },

  /* ---- 알림 ---- */
  {
    id: 25,
    file: NOTIFY,
    what: "hidden 판정 제거 — 보고 있는데도 알린다",
    from: "if (!isHidden() || !permissionGranted()) return false;",
    to: "if (!permissionGranted()) return false;",
  },
  {
    id: 26,
    file: NOTIFY,
    what: "granted 비교를 느슨하게 — default 도 통과",
    from: 'return globalThis.Notification?.permission === "granted";',
    to: 'return globalThis.Notification?.permission !== "denied";',
  },
  {
    id: 27,
    file: NOTIFY,
    what: "알림 실패 격리 제거 — 예외가 화면으로 샌다",
    edits: [
      ["  try {\n    const container", "  {\n    const container"],
      [
        "    return true;\n  } catch {\n    // 미지원·거부·SW 미등록 전부 여기로 온다. 알림이 없을 뿐 기록과 화면은 그대로 간다.\n    return false;\n  }",
        "    return true;\n  }",
      ],
    ],
  },
  {
    id: 28,
    file: NOTIFY,
    what: "잠금화면 문구에 운동명·중량을 넣기",
    from: "      body: REST_NOTIFICATION.body,",
    to: '      body: "벤치프레스 60kg 3세트 휴식이 끝났어요",',
  },
  {
    id: 29,
    file: SHEET,
    what: "**알림 중복 방지 제거** — lint 를 피하는 의미상 동등 변이",
    // `if (false)` 는 `no-constant-condition` 이 잡아 버려서 "행동 테스트가 죽였다"를 증명하지 못한다.
    // 항상 거짓이지만 상수가 아닌 비교로 바꿔 **테스트만이** 잡게 한다.
    from: "    if (notifiedRef.current === timer.endsAt) return;",
    to: "    if (notifiedRef.current === undefined) return;",
  },
  {
    id: 30,
    file: SHEET,
    what: "알림 이펙트 의존성에서 finished·endsAt 제거",
    from: "  }, [open, finished, timer.endsAt]);",
    to: "  }, [open]);",
    oracle: "lint",
  },

  /* ---- 실제 화면 배선 (helper 만 옳고 아무도 부르지 않는 상태를 잡는다) ---- */
  {
    id: 31,
    file: SCREEN,
    what: "세트 완료 뒤 **save 호출 제거**",
    from: "    void restTimerStore.save(sessionId, next.plannedSetId, next.title, next.timer);",
    to: "    void 0;",
  },
  {
    id: 32,
    file: SCREEN,
    // 닫기의 clear 자체는 #50·#51 이 다룬다. 여기서는 **세대 무효화**만 떼어 본다.
    what: "휴식 닫을 때 **복구 무효화 제거** — 늦은 복구가 닫은 타이머를 되살린다",
    from: "    const from = rest?.plannedSetId;\n    // 닫는 것은 사용자의 최종 의사다 — 뒤늦은 복구가 되살리지 못하게 먼저 세대를 올린다.\n    restoreRef.current?.invalidate();",
    to: "    const from = rest?.plannedSetId;",
  },
  {
    id: 33,
    file: SCREEN,
    what: "완료 취소의 **조건부 clear 제거**",
    from:
      "    if (!(await restTimerStore.clearForPlannedSet(sessionId, set.id)))\n" +
      "      setNotice(CLEAR_FAILED_NOTICE);",
    to: "    void 0;",
  },
  {
    id: 34,
    file: SCREEN,
    what: "완료 취소를 **화면에 타이머가 있을 때만** 지우도록 되돌리기",
    from:
      "    if (!(await restTimerStore.clearForPlannedSet(sessionId, set.id)))\n" +
      "      setNotice(CLEAR_FAILED_NOTICE);",
    to: "    if (rest?.plannedSetId === set.id) void restTimerStore.clear(sessionId);",
  },
  {
    id: 35,
    file: SCREEN,
    // 종료의 clear 는 #53 이 다룬다. 여기서는 **실패 안내**를 떼어 본다.
    what: "세션 종료의 **정리 실패 안내 제거** — 조용히 넘어간다",
    from: "      if (!(data as { timerCleared?: boolean }).timerCleared) setNotice(CLEAR_FAILED_NOTICE);\n      else if",
    to: "      if (false) setNotice(CLEAR_FAILED_NOTICE);\n      else if",
  },
  {
    id: 36,
    file: SCREEN,
    what: "연장(+초) 때 **save 호출 제거**",
    from: "            void restTimerStore.save(sessionId, rest.plannedSetId, rest.title, timer);",
    to: "            void 0;",
  },
  {
    id: 37,
    file: SCREEN,
    what: "매핑 때 **저장된 타이머 승격 제거**",
    from: "        void restTimerStore.remap(sessionId, mapping.correlation_id, mapping.planned_set_id);",
    to: "        void 0;",
  },
  {
    id: 38,
    file: SCREEN,
    what: "**복구 effect 무력화** — 저장은 하는데 아무도 읽지 않는다",
    // 이펙트 본문을 지우면 미사용 변수로 타입·lint 가 먼저 죽어 테스트 방어력을 증명하지 못한다.
    // 그래서 **문법적으로 유효하게** guard 를 항상 반환시켜 복구만 사라지게 한다.
    from: "    if (!token) return;",
    to: "    if (token) return;",
  },
  {
    id: 39,
    file: SCREEN,
    what: "세션 전환 때 **무효화 제거** — 앞 세션 결과가 새 화면에 얹힌다",
    from: "  useEffect(() => {\n    dropRest();\n    return () => restoreRef.current?.invalidate();\n  }, [sessionId, dropRest]);",
    to: "  useEffect(() => {\n    setRest(null);\n  }, [sessionId]);",
  },
  {
    id: 40,
    file: SCREEN,
    what: "세트 완료 때 **무효화 제거** — 늦은 복구가 새 타이머를 덮는다",
    from: "    restoreRef.current?.invalidate();\n    setRest(next);",
    to: "    setRest(next);",
  },

  /* ---- 재리뷰 P2: 시간 관계 계약 ---- */
  {
    id: 41,
    file: STORE,
    what: "**관계 검증 제거** — 1초짜리인데 1년 뒤 끝나는 좀비가 통과한다",
    from: "  if (hasImpossibleSpan(parsedRecord)) return null;",
    to: "  if (false) return null;",
    oracle: "test",
  },
  {
    id: 42,
    file: STORE,
    what: "시작 시각이 저장 시점보다 미래여도 통과시키기",
    from: "  return startedAt > record.saved_at || startedAt <= 0;",
    to: "  return startedAt <= 0;",
  },
  {
    id: 43,
    file: STORE,
    what: "시작 시각이 epoch 이전이어도 통과시키기 — 터무니없는 total",
    from: "  return startedAt > record.saved_at || startedAt <= 0;",
    to: "  return startedAt > record.saved_at;",
  },
  {
    id: 44,
    file: STORE,
    what: "total_sec 양수 검사를 비음수로 되돌리기 — 0 이 통과한다",
    from: "  if (!isPositiveInt(record.total_sec)) return null;",
    to: '  if (typeof record.total_sec !== "number" || record.total_sec < 0) return null;',
  },
  {
    id: 45,
    file: STORE,
    what: "안전정수 검사를 정수 검사로 낮추기 — MAX_SAFE_INTEGER 초과 통과",
    from: '  typeof value === "number" && Number.isSafeInteger(value) && value > 0;',
    to: '  typeof value === "number" && Number.isInteger(value) && value > 0;',
  },
  {
    id: 46,
    file: STORE,
    what: "saved_at 검증 제거 — 기준점 없이 관계를 판정한다",
    from: "  if (!isPositiveInt(record.saved_at)) return null;",
    to: "  if (record.saved_at === undefined) return null;",
  },

  /* ---- 재리뷰 P1: 전역 승격 ---- */
  {
    id: 47,
    file: STORE,
    what: "**전역 승격을 무력화** — 화면 없는 sync 에서 correlation id 가 남는다",
    from: "  if (mappings.length === 0) return 0;",
    to: "  return 0;\n  // eslint-disable-next-line no-unreachable",
  },
  {
    id: 48,
    file: STORE,
    what: "전역 승격이 **다른 세트** 레코드까지 옮기게 만들기",
    from: "    if (!mapping || mapping.planned_set_id === record.planned_set_id) continue;",
    to: "    if (!mapping) continue;",
  },
  {
    id: 49,
    file: COORDINATOR,
    what: "**커밋 트랜잭션에서 승격 호출 제거** — UI 이벤트에만 의존하게 된다",
    from: "    await remapRestTimersInTransaction(this.userId, mappings);",
    to: "    void 0;",
  },

  /* ---- 재리뷰 P1: terminal clear ---- */
  {
    id: 50,
    file: SCREEN,
    what: "**닫기를 fire-and-forget 으로 되돌리기** — 새로고침에서 유령 타이머",
    from: "    if (!(await restTimerStore.clear(sessionId))) {\n      setNotice(CLEAR_FAILED_NOTICE);\n      return;\n    }\n    setRest(null);",
    to: "    void restTimerStore.clear(sessionId);\n    setRest(null);",
  },
  {
    id: 51,
    file: SCREEN,
    what: "삭제 실패를 성공으로 가장하기 — 시트를 닫아 버린다",
    from: "    if (!(await restTimerStore.clear(sessionId))) {\n      setNotice(CLEAR_FAILED_NOTICE);\n      return;\n    }",
    to: "    await restTimerStore.clear(sessionId);",
  },
  {
    id: 52,
    file: SCREEN,
    what: "완료 취소의 삭제 실패를 조용히 넘기기",
    from: "    if (!(await restTimerStore.clearForPlannedSet(sessionId, set.id)))\n      setNotice(CLEAR_FAILED_NOTICE);",
    to: "    void restTimerStore.clearForPlannedSet(sessionId, set.id);",
  },
  {
    id: 53,
    file: SCREEN,
    what: "세션 종료의 clear 를 기다리지 않기",
    from: "      const timerCleared = await restTimerStore.clear(sessionId);",
    to: "      const timerCleared = true;\n      void restTimerStore.clear(sessionId);",
  },
  /* ---- 후속 재리뷰: 복구 자격 · 별칭 · future saved_at ---- */
  {
    id: 55,
    file: STORE,
    what: "**완료 사실 확인 제거** — 취소한 세트의 타이머가 되살아난다",
    from: "  return eligibility.completedPlannedSetIds.has(plannedSetId);",
    to: "  return true;",
  },
  {
    id: 56,
    file: STORE,
    what: "**종료된 세션 차단 제거** — 끝난 세션에서도 복구한다",
    from: "  if (eligibility.sessionCompleted) return false;",
    to: "  if (false) return false;",
  },
  {
    id: 57,
    file: STORE,
    what: "자격 추출이 완료 여부를 무시하고 모든 세트를 담는다",
    from: '    if (typeof set?.id === "string" && set.performed_set != null) completed.add(set.id);',
    to: '    if (typeof set?.id === "string") completed.add(set.id);',
  },
  {
    id: 58,
    file: STORE,
    what: "세션 status 판정을 뒤집는다",
    from: '  return { sessionCompleted: session.status === "completed", completedPlannedSetIds: completed };',
    to: "  return { sessionCompleted: false, completedPlannedSetIds: completed };",
  },
  {
    id: 59,
    file: STORE,
    what: "**future saved_at 가드 제거** — 시계 되돌림 좀비가 산다",
    from: "  if (parsedRecord.saved_at > now) return null;",
    to: "  if (false) return null;",
  },
  {
    id: 60,
    file: STORE,
    what: "future 가드를 관용치로 느슨하게(임의 5분)",
    from: "  if (parsedRecord.saved_at > now) return null;",
    to: "  if (parsedRecord.saved_at > now + 300_000) return null;",
  },
  {
    id: 61,
    file: STORE,
    what: "**별칭 조회를 저장 트랜잭션 밖으로** — 매핑이 그 사이 커밋되면 옛 id 로 쓴다",
    from: "        const canonical = await resolveCanonicalPlannedSetId(userId, plannedSetId);",
    to: "        const canonical = plannedSetId;",
  },
  {
    id: 62,
    file: STORE,
    what: "**별칭 쓰기 제거** — 매핑 뒤 저장이 correlation id 로 남는다",
    from: "      key: aliasKeyFor(mapping.correlation_id),",
    to: "      key: `unused-alias:${mapping.correlation_id}`,",
  },
  {
    id: 63,
    file: STORE,
    what: "별칭 버전 확인 제거 — 모르는 모양을 따라간다",
    from: "    if (record.v !== REST_TIMER_ALIAS_VERSION) return null;",
    to: "    if (false) return null;",
  },
  {
    id: 64,
    file: STORE,
    what: "손상 별칭 fail-closed 제거 — 파싱 실패가 위로 샌다",
    edits: [
      ["  try {\n    const parsed = JSON.parse(raw);", "  {\n    const parsed = JSON.parse(raw);"],
      [
        "    return { to: record.to, at };\n  } catch {\n    return null;\n  }\n}",
        "    return { to: record.to, at };\n  }\n}",
      ],
    ],
  },
  {
    id: 65,
    file: STORE,
    what: "별칭 순환 상한 제거 — 무한 루프",
    from: "    if (alias === null || alias.to === current || seen.has(alias.to)) break;",
    to: "    if (alias === null || alias.to === current) break;",
  },
  {
    id: 66,
    file: STORE,
    what: "별칭 보존 정리 제거 — 무한 누적",
    from: "    if (alias !== null && now - alias.at < REST_TIMER_ALIAS_RETENTION_MS) continue;",
    to: "    continue;",
  },
  {
    id: 67,
    file: STORE,
    what: "**로컬 의사 overlay 제거** — 서버 사실만 본다",
    from:
      "  const local = eligibility.localCompleted.get(plannedSetId);\n" +
      "  if (local !== undefined) return local;",
    to: "  void eligibility.localCompleted;",
  },
  {
    id: 68,
    file: STORE,
    what: "로컬 **완료** 의사 무시 — 오프라인 완료 타이머가 지워진다",
    from: "  if (local !== undefined) return local;",
    to: "  if (local === false) return false;",
  },
  {
    id: 69,
    file: STORE,
    what: "로컬 **취소** 의사 무시 — 취소한 타이머가 되살아난다",
    from: "  if (local !== undefined) return local;",
    to: "  if (local === true) return true;",
  },
  {
    id: 70,
    file: STORE,
    what: "로컬 의사를 읽지 않는다(빈 맵) ",
    from: "    return new Map(rows.map((row) => [row.planned_set_id, row.completed === true]));",
    to: "    return new Map();",
  },
  {
    id: 54,
    file: STORE,
    what: "clear 가 실패해도 성공을 보고하게 만들기",
    from: "    await sessionDb.syncMeta.delete([userId, restTimerKeyFor(sessionId)]);\n    return true;\n  } catch {\n    return false;\n  }",
    to: "    await sessionDb.syncMeta.delete([userId, restTimerKeyFor(sessionId)]);\n    return true;\n  } catch {\n    return true;\n  }",
  },
];

/**
 * **등가 뮤턴트.** 관측 동작이 원본과 같아 어떤 테스트로도 죽일 수 없는 것들.
 * 이유는 하나다 — fail-soft `try/catch` 가 그 분기를 이미 삼킨다. 숨기지 않고 표에 남긴다.
 */
const KNOWN_EQUIVALENT = new Map([
  [
    45,
    "안전정수를 벗어난 정수는 2^53(서기 28만년) 이상이라, ends_at·saved_at 이면 관계/미래 가드가 " +
      "먼저 잡고 total_sec 이면 span 의 isSafeInteger 가 잡는다 → 구분 가능한 입력이 없다",
  ],
  [
    32,
    "표가 미결인 창은 begin 과 load resolve 사이뿐이고, 그 창에서 시트를 여는 유일한 경로인 " +
      "handleComplete 가 이미 invalidate 한다(begin 은 세션당 1회라 두 번째 복구가 없다). " +
      "→ 닫기의 invalidate 는 관측 결과를 바꾸지 않는 이중 방어다",
  ],
  [
    40,
    "setRest(previous => previous ?? stored) 가 이미 덮어쓰기를 막고, rest 를 null 로 만드는 모든 경로" +
      "(닫기·완료취소·세션종료·세션전환)가 저마다 invalidate 한다 → 저장 시점의 invalidate 는 " +
      "관측 결과를 바꾸지 않는 이중 방어다",
  ],
  [
    16,
    "읽기·판정·삭제가 한 큐 안에 있어 그 사이 다른 쓰기가 끼어들 수 없다 → 원문 대조는 " +
      "큐가 깨질 때를 대비한 이중 방어이고 현 구조에서는 관측 결과가 같다",
  ],
  [
    21,
    "isCurrent 가 current !== null 을 먼저 보므로 invalidate 는 세대를 올리지 않아도 표를 무효화한다. " +
      "다음 begin 이 어차피 세대를 올려 옛 표와 갈린다 → 관측 결과 동일",
  ],
]);

const VITEST_ENTRY = join(
  dirname(createRequire(join(WEB_DIR, "package.json")).resolve("vitest/package.json")),
  "vitest.mjs",
);
const ESLINT_ENTRY = join(
  dirname(createRequire(join(ROOT, "package.json")).resolve("eslint/package.json")),
  "bin",
  "eslint.js",
);

class SpawnError extends Error {}

function run(args, cwd) {
  try {
    execFileSync(process.execPath, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
    });
    return { failed: false, output: "" };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    // 명령이 **돌지도 못한** 것은 "테스트가 잡았다"가 아니다. 거짓 RED 를 막는다.
    if (!output.trim()) throw new SpawnError(`오라클을 실행하지 못했다: ${error.message}`);
    return { failed: true, output };
  }
}

const TARGETED = [
  "test/rest-timer-persistence.test.ts",
  "test/rest-notification.test.ts",
  "test/rest-timer-ordering.test.ts",
  "test/rest-timer-wiring.test.tsx",
  "test/rest-timer-sync-remap.test.ts",
];

const runTests = () => run([VITEST_ENTRY, "run", ...TARGETED], WEB_DIR);
const runLint = () =>
  run(
    [
      ESLINT_ENTRY,
      "apps/web/components/session/RestTimerSheet.tsx",
      "apps/web/components/session/SessionScreen.tsx",
      "apps/web/components/session/rest-timer-store.ts",
      "apps/web/components/session/sync-coordinator.ts",
    ],
    ROOT,
  );

const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (text) => text.replace(ANSI, "");

/**
 * 파일을 **읽지 못해** 죽은 RED 는 무효다. 런타임 `SyntaxError` 는 여기 넣지 않는다 —
 * JSON 격리를 지우는 뮤테이션이 정확히 그걸 일으키고, 그건 테스트가 제대로 잡은 것이다.
 */
const INVALID_RED = /Transform failed|Failed to (?:load|parse)|error TS\d+/i;

function summarize(oracle, output) {
  const stripped = stripAnsi(output);
  if (oracle === "lint") {
    return /react-hooks\/exhaustive-deps/.test(stripped)
      ? "eslint react-hooks/exhaustive-deps"
      : (/error\s+(.*)/.exec(stripped)?.[1]?.trim() ?? "(lint 실패)");
  }
  const counts = /Tests\s+(\d+ failed[^\n|]*)/.exec(stripped)?.[1]?.trim();
  const first =
    /FAIL[^\n]*?>[^\n]*?>\s*([^\n]+)/.exec(stripped)?.[1]?.trim() ??
    /(?:AssertionError|Error):\s*([^\n]+)/.exec(stripped)?.[1]?.trim();
  return [counts, first].filter(Boolean).join(" · ") || "(요약 추출 실패)";
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", shell: false }).trim();
}

const TARGET_FILES = [...NAMES.keys()];

/** 실행 전후로 **추적 파일이 하나도 달라지지 않았는지** 본다(테스트 산출물 포함). */
function trackedResidue() {
  return git(["status", "--porcelain"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const selfTestOnly = process.argv.includes("--self-test");

  // ---- baseline: 대상 파일이 깨끗해야 원복이 무엇으로 되돌리는지 말할 수 있다 ----
  const dirtyTargets = git(["status", "--porcelain", "--", ...TARGET_FILES])
    .split("\n")
    .filter(Boolean);
  if (dirtyTargets.length > 0) {
    console.error("대상 파일에 커밋되지 않은 변경이 있다. 원복 기준이 모호해 중단한다:");
    for (const line of dirtyTargets) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  const baseline = new Map(TARGET_FILES.map((file) => [file, sha(file)]));
  const residueBefore = trackedResidue();

  // ---- self-test: 러너가 정말 실패를 감지하는가 ----
  // 무결점 상태에서 오라클이 통과하고, 고의로 심은 결함에서 실패해야 한다.
  // 둘 중 하나라도 어긋나면 이 표 전체를 믿을 수 없다.
  const clean = runTests();
  if (clean.failed) {
    console.error("무결점 트리에서 오라클이 실패했다. 표를 만들지 않는다.");
    console.error(summarize("test", clean.output));
    process.exitCode = 1;
    return;
  }
  const probe = MUTATIONS[0];
  const probeOriginal = readFileSync(probe.file, "utf8");
  let probeDetected = false;
  try {
    writeFileSync(probe.file, probeOriginal.replace(probe.from, probe.to));
    probeDetected = runTests().failed;
  } finally {
    writeFileSync(probe.file, probeOriginal);
  }
  if (!probeDetected) {
    console.error("심어 둔 결함을 러너가 감지하지 못했다. 오라클 배선이 깨졌다.");
    process.exitCode = 1;
    return;
  }
  console.log("self-test: 무결점 통과 · 심은 결함 감지 — 러너 정상\n");
  if (selfTestOnly) return;

  console.log("| # | 파일 | 주입한 결함 | 오라클 | 결과 | 잡아낸 근거 |");
  console.log("| --- | --- | --- | --- | --- | --- |");

  let survivors = 0;
  let invalid = 0;
  let skipped = 0;

  for (const mutation of MUTATIONS) {
    if (mutation.skip) {
      // **승인 없는 skip 은 실패다.** 건너뛴 변이는 아무것도 증명하지 않는다.
      skipped += 1;
      console.log(
        `| ${mutation.id} | \`${NAMES.get(mutation.file)}\` | ${mutation.what} | — | **건너뜀(실패)** | 실행 가능한 변이로 바꿔야 한다 |`,
      );
      continue;
    }
    const oracle = mutation.oracle ?? "test";
    const original = readFileSync(mutation.file, "utf8");
    const edits = mutation.edits ?? [[mutation.from, mutation.to]];
    let mutated = original;
    let anchored = true;
    for (const [from, to] of edits) {
      if (!mutated.includes(from)) anchored = false;
      else mutated = mutated.replace(from, to);
    }
    if (!anchored) {
      survivors += 1;
      console.log(
        `| ${mutation.id} | \`${NAMES.get(mutation.file)}\` | ${mutation.what} | — | **앵커 없음** | 스크립트 갱신 필요 |`,
      );
      continue;
    }

    let result;
    try {
      writeFileSync(mutation.file, mutated);
      result = oracle === "lint" ? runLint() : runTests();
    } finally {
      // **무슨 일이 있어도 원복한다.** 예외로 빠져나가도 망가진 파일을 남기지 않는다.
      writeFileSync(mutation.file, original);
    }
    if (sha(mutation.file) !== baseline.get(mutation.file))
      throw new Error(`원복 실패: ${relative(ROOT, mutation.file)}`);

    if (result.failed && INVALID_RED.test(stripAnsi(result.output))) {
      invalid += 1;
      console.log(
        `| ${mutation.id} | — | ${mutation.what} | ${oracle} | **무효** | 파일 로드 실패로 죽었다 |`,
      );
      continue;
    }

    const equivalent = KNOWN_EQUIVALENT.get(mutation.id);
    if (!result.failed && !equivalent) survivors += 1;
    const verdict = result.failed ? "**RED**" : equivalent ? "등가" : "**생존**";
    const evidence = result.failed ? summarize(oracle, result.output) : (equivalent ?? "—");
    console.log(
      `| ${mutation.id} | \`${NAMES.get(mutation.file)}\` | ${mutation.what} | ${oracle} | ${verdict} | ${evidence} |`,
    );
  }

  // ---- 잔류 검사: sha256 과 추적 파일 상태를 모두 본다 ----
  for (const file of TARGET_FILES) {
    if (sha(file) !== baseline.get(file))
      throw new Error(`최종 sha 불일치: ${relative(ROOT, file)}`);
  }
  const residueAfter = trackedResidue();
  const leaked = residueAfter.filter((line) => !residueBefore.includes(line));
  if (leaked.length > 0) {
    console.error("\n실행이 추적 파일을 남겼다:");
    for (const line of leaked) console.error(`  ${line}`);
    process.exitCode = 1;
  }

  const counted = MUTATIONS.length - skipped;
  const red = counted - KNOWN_EQUIVALENT.size - survivors - invalid;
  console.log(
    `\n${MUTATIONS.length}건 중 실행 ${counted} · RED ${red} · 등가 ${KNOWN_EQUIVALENT.size} · ` +
      `무효 ${invalid} · 건너뜀 ${skipped} · **미방어 생존 ${survivors}**.`,
  );
  console.log(`대상 ${TARGET_FILES.length}개 sha256 불변 · 추적 파일 잔류 ${leaked.length}건.`);
  if (survivors > 0 || invalid > 0 || skipped > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  if (error instanceof SpawnError) console.error(`\n[spawn] ${error.message}`);
  else console.error(`\n${error.stack ?? error}`);
  process.exitCode = 1;
}

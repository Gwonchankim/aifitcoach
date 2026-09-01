/* global process, console, URL */
/**
 * F-4b mutation 표. copy · client 소비 · migration 범위 · refetch 를 **각각 독립으로** 죽여 본다.
 * 하나로 뭉친 테스트로 갈음하지 않는 것이 governing AC 다.
 *
 * 사용: node scripts/mutation-f4b.mjs [행번호...]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RULES = "apps/web/components/session/set-rules.ts";
const DB = "apps/web/components/session/session-db.ts";
const COORDINATOR = "apps/web/components/session/sync-coordinator.ts";
const SCREEN = "apps/web/components/session/SessionScreen.tsx";

const RENDER = "test/assistance-render.test.ts";
const V4 = "test/assistance-dexie-v4.test.ts";
const INGRESS = "test/assistance-ingress.test.ts";
const COORD = "test/sync-coordinator.test.ts";
const SCREENSPEC = "test/assistance-session-screen.test.ts";

const TABLE = [
  {
    n: 1,
    label: "copy — 통증 문구를 generic 으로 되돌린다",
    file: RULES,
    from: 'export const ASSISTANCE_PAIN_COPY = "통증이 있어 이 운동을 중단하고 무통 대체 운동으로 바꾸세요.";',
    to: 'export const ASSISTANCE_PAIN_COPY = "통증이 기록돼서 다른 운동을 권해요";',
    specs: [RENDER],
  },
  {
    n: 2,
    label: "copy — 입력 오류 문구를 바꾼다",
    file: RULES,
    from: 'export const ASSISTANCE_INVALID_COPY = "입력값을 확인한 뒤 다시 시도하세요.";',
    to: 'export const ASSISTANCE_INVALID_COPY = "값을 다시 확인해 주세요.";',
    specs: [RENDER],
  },
  {
    n: 3,
    label: "copy — 어시스트 행에 generic weighted 문구를 허용한다",
    file: RULES,
    from: "    return ASSISTANCE_REASON_TEXT[code] ?? null;",
    to: "    return ASSISTANCE_REASON_TEXT[code] ?? REASON_TEXT[code] ?? null;",
    specs: [RENDER],
  },
  {
    n: 4,
    label: "client — 안전 상태에서도 서버 무게를 prefill 한다",
    file: RULES,
    from: '    weight: kind === "weighted" && !isAssistanceSafetyState(set) ? set.recommended_weight : null,',
    to: '    weight: kind === "weighted" ? set.recommended_weight : null,',
    specs: [RENDER],
  },
  {
    n: 5,
    label: "client — 도움 배지에서 음수·0 가드를 뺀다",
    file: RULES,
    from: '  if (typeof weight !== "number" || weight <= 0) return null;',
    to: '  if (typeof weight !== "number") return null;',
    specs: [RENDER],
  },
  {
    n: 6,
    label: "client — 안전 상태에서도 recommended_action 을 쓴다",
    file: RULES,
    from: "  if (!isAssistanceSet(set) || isAssistanceSafetyState(set)) return null;\n  return set.recommended_action ?? null;",
    to: "  if (!isAssistanceSet(set)) return null;\n  return set.recommended_action ?? null;",
    specs: [RENDER],
  },
  {
    n: 7,
    label: "migration — 축이 없는 구버전 미러를 안전으로 본다(fail open)",
    file: DB,
    // whitelist 도입 뒤 앵커를 갱신했다. #21 은 오타·null 을 통과시키는 축이고,
    // 여기는 **축이 아예 없는 구버전 미러**를 non-assistance 로 보는 축이다(서로 다른 실패다).
    from: '  if (typeof row.load_kind !== "string" || !LOAD_KINDS.has(row.load_kind)) return false;',
    to: "  if (row.load_kind !== undefined && !LOAD_KINDS.has(row.load_kind as string)) return false;",
    specs: [V4, INGRESS],
  },
  {
    n: 8,
    label: "migration — drafts 까지 지운다",
    file: DB,
    from: "    await sessions.delete(pair);",
    to: '    await sessions.delete(pair);\n    await (tx.table("drafts") as unknown as SessionDatabase["drafts"]).clear();',
    specs: [V4],
  },
  {
    n: 9,
    label: "migration — 안전한 세션까지 전부 무효화한다",
    file: DB,
    from: "    if (!isSafeSessionPayload(row.session, new Set(row.local_ids ?? [])))\n      affected.push({ user_id: row.user_id, session_id: row.session_id });",
    to: "    affected.push({ user_id: row.user_id, session_id: row.session_id });",
    specs: [V4],
  },
  {
    n: 10,
    label: "migration — marker 를 남기지 않는다",
    file: DB,
    from: "    await syncMeta.put({\n      user_id: key.user_id,\n      key: markerKeyFor(key.session_id),\n      value: REMEDIATION_PENDING,\n    });",
    to: "",
    specs: [V4],
  },
  {
    n: 11,
    label: "refetch — 200 이면 predicate 없이 marker 를 지운다",
    file: DB,
    from: "  if (!isSafeSessionPayload(session)) return false;",
    to: "",
    specs: [V4],
  },
  {
    n: 12,
    label: "atomicity — marker delete 를 transaction 밖으로 뺀다",
    file: DB,
    from: `  await sessionDb.transaction("rw", sessionDb.sessions, sessionDb.syncMeta, async () => {
    await sessionDb.sessions.put({
      user_id: userId,
      session_id: sessionId,
      session,
      updated_at: new Date().toISOString(),
    });
    await sessionDb.syncMeta.delete([userId, markerKeyFor(sessionId)]);
  });`,
    to: `  await sessionDb.sessions.put({
    user_id: userId,
    session_id: sessionId,
    session,
    updated_at: new Date().toISOString(),
  });
  await sessionDb.syncMeta.delete([userId, markerKeyFor(sessionId)]);`,
    specs: [INGRESS],
  },
  {
    n: 13,
    label: "refetch — marker 가 있어도 오프라인 미러로 폴백한다",
    file: DB,
    from: "    if (await isRemediationPending(userId, sessionId)) throw error;",
    to: "",
    specs: [V4],
  },
  {
    n: 14,
    label: "client — 음수 무게 가드를 뺀다",
    file: RULES,
    from: "  return value !== null && value < 0 ? null : value;",
    to: "  return value;",
    specs: [RENDER],
  },
  {
    n: 15,
    label: "refetch — 서버 raw verdict(unsafe/누락)를 무시한다",
    file: DB,
    from: "  return row.assistance_safety_status === 'safe';".replace(/'/g, '"'),
    to: '  return row.assistance_safety_status !== "unsafe";',
    specs: [V4],
  },
  {
    // E2E 45건을 깨뜨린 그 회귀다. 게이트된 값으로 재계산하면 정상 세션이 전부 unsafe 가 된다.
    n: 16,
    label: "refetch — 게이트된 state/reason 을 다시 계산해 safe 를 뒤집는다",
    file: DB,
    from: '  return row.assistance_safety_status === "safe";',
    to: '  return row.assistance_safety_status === "safe" && row.recommendation_state != null;',
    specs: [V4],
  },
  {
    n: 17,
    label: "ingress — mirrorSession 의 fail-closed 게이트를 뺀다",
    file: DB,
    from: `  if (!isSafeSessionPayload(session, localIds)) {
    await markRemediationPending(userId, sessionId);
    return false;
  }`,
    to: "",
    specs: [INGRESS],
  },
  {
    n: 18,
    label: "ingress — routine 스냅샷이 unsafe 여도 미러에 쓴다",
    file: DB,
    from: "        if (isSafeSessionPayload(session, merged))",
    to: "        if (true)",
    specs: [INGRESS],
  },
  {
    n: 19,
    label: "ingress — sync 매핑 필터를 뺀다(모든 매핑을 미러에 심는다)",
    file: COORDINATOR,
    from: "        const safe = safeById.get(set.id);",
    to: "        const safe = mapping;",
    specs: [COORD],
  },
  {
    n: 20,
    label: "validator — planned_sets 구조 검사를 뺀다",
    file: DB,
    from: "  if (!Array.isArray(sets)) return null;",
    to: "  if (!Array.isArray(sets)) return [];",
    specs: [INGRESS],
  },
  {
    n: 21,
    label: "validator — load_kind whitelist 를 뺀다",
    file: DB,
    from: `  if (typeof row.load_kind !== "string" || !LOAD_KINDS.has(row.load_kind)) return false;`,
    to: "  if (row.load_kind === undefined) return false;",
    specs: [INGRESS],
  },
  {
    n: 22,
    label: "lifecycle — marker processor 를 무력화한다",
    file: DB,
    from: "  for (const row of pending) {",
    to: "  for (const row of []) {",
    specs: [INGRESS],
  },
  {
    n: 23,
    label: "lifecycle — 404/410 terminal cleanup 을 뺀다",
    file: DB,
    from: "  return status === 404 || status === 410;",
    to: "  return false;",
    specs: [INGRESS],
  },
  {
    n: 24,
    label: "lifecycle — 401 도 terminal 로 본다(marker 를 잘못 지운다)",
    file: DB,
    from: "  return status === 404 || status === 410;",
    to: "  return status === 404 || status === 410 || status === 401;",
    specs: [INGRESS],
  },
  {
    n: 25,
    label: "도움 축 — 목표 줄을 generic 추천 nkg 로 되돌린다",
    file: RULES,
    from: `  const assistance = assistanceBadge(set);
  if (assistance) {
    parts.push(assistance.text);
    return parts.join(" · ");
  }`,
    to: "",
    specs: [RENDER],
  },
  {
    n: 26,
    label: "도움 축 — 입력칸 label·placeholder 를 무게로 되돌린다",
    file: RULES,
    from: '  return isAssistanceSet(set) ? "도움" : "무게";',
    to: '  return "무게";',
    specs: [RENDER],
  },
  {
    n: 27,
    label: "P1-1 ingress — edit refetch 가 predicate 전에 캐시에 쓴다",
    file: SCREEN,
    from: "  if (!(await mirrorSession(DEV_USER_SCOPE, sessionId, fetched).catch(() => false))) return null;",
    to: "  await mirrorSession(DEV_USER_SCOPE, sessionId, fetched).catch(() => false);",
    specs: [SCREENSPEC],
  },
  {
    n: 28,
    label: "P1-1 ingress — query mapping 이 unsafe 처방을 그대로 합성한다",
    file: SCREEN,
    from: "      return trusted ? trusted.planned_set : { ...set, id: mapping.planned_set_id };",
    to: "      return mapping.planned_set;",
    specs: [SCREENSPEC],
  },
  {
    n: 29,
    label: "P1-2 identity — blocked 매핑에서 id 를 옮기지 않는다",
    file: COORDINATOR,
    from: "          return { ...set, id: mapping.planned_set_id };",
    to: "          return set;",
    specs: [COORD],
  },
  {
    n: 30,
    label: "P1-3 durability — marker put 실패를 다시 삼킨다",
    file: DB,
    from: "    await sessionDb.sessions.delete([userId, sessionId]);",
    to: "",
    specs: [INGRESS],
  },
  {
    n: 31,
    label: "P2-1 origin — payload 의 provisional 주장을 다시 믿는다",
    file: DB,
    from: '  if (localIds !== undefined && typeof row.id === "string" && localIds.has(row.id))',
    to: "  if (row.provisional === true || (localIds !== undefined && localIds.has(row.id as string)))",
    specs: [INGRESS],
  },
  {
    n: 32,
    label: "P2-1 origin — 로컬 baseline 을 무게 하나로만 본다",
    file: DB,
    from: "  if (row.recommendation_state != null) return false;",
    to: "",
    specs: [INGRESS],
  },
  {
    n: 33,
    label: "P2-2 lifecycle — 완료 정리에서 캐시를 놔두고 marker 만 지운다",
    file: COORDINATOR,
    from: "      await sessionDb.sessions.delete([this.userId, sessionId]);",
    to: "",
    specs: [COORD],
  },
  {
    n: 34,
    label: "P2-2 lifecycle — outbox drain 확인 없이 정리한다",
    file: COORDINATOR,
    from: "      if (await this.hasPendingForSession(sessionId)) continue;",
    to: "",
    specs: [COORD],
  },
  {
    n: 35,
    label: "P2-3 production — sync 의 marker processor 호출 줄을 제거한다",
    file: COORDINATOR,
    from: "      await processRemediationMarkers(this.userId, this.fetchSession).catch(() => undefined);",
    to: "",
    specs: [COORD],
  },
  {
    n: 36,
    label: "P1-1 GET — readThroughSession 이 marker 경계를 우회한다",
    file: DB,
    from: "      await markRemediationPending(userId, sessionId);",
    to: "      await sessionDb.syncMeta.put({ user_id: userId, key: markerKeyFor(sessionId), value: REMEDIATION_PENDING }).catch(() => undefined);",
    specs: [INGRESS],
  },
  {
    n: 37,
    label: "P1-2 drain — performed_set outbox 를 sessionId 로만 센다",
    file: COORDINATOR,
    from: "    return rows.some((row) => row.entity_id === sessionId || planned.has(row.entity_id));",
    to: "    return rows.some((row) => row.entity_id === sessionId);",
    specs: [COORD],
  },
  {
    n: 38,
    label: "P1-3 envelope — 기존 local_ids 와 합치지 않는다",
    file: DB,
    from: "          [...(previous?.local_ids ?? []), ...(localIds ?? [])].filter((id) => present.has(id)),",
    to: "          [...(localIds ?? [])].filter((id) => present.has(id)),",
    specs: [INGRESS],
  },
  {
    n: 39,
    label: "P1-3 envelope — 현재 스냅샷 교집합을 빼 봉투가 무한히 커진다",
    file: DB,
    from: "          [...(previous?.local_ids ?? []), ...(localIds ?? [])].filter((id) => present.has(id)),",
    to: "          [...(previous?.local_ids ?? []), ...(localIds ?? [])],",
    specs: [INGRESS],
  },
  {
    n: 40,
    label: "P2-1 terminal — 404/410 에서 marker 만 지우고 캐시를 남긴다",
    file: DB,
    from: "      if (isTerminalStatus(error)) await cleanupSessionCache(userId, sessionId);",
    to: "      if (isTerminalStatus(error)) await clearRemediationMarker(userId, sessionId);",
    specs: [INGRESS],
  },
  {
    n: 41,
    label: "P2-1 terminal — 읽기 경로의 404/410 도 marker 만 지운다",
    file: DB,
    from: "      await cleanupSessionCache(userId, sessionId).catch(() => undefined);",
    to: "      await clearRemediationMarker(userId, sessionId).catch(() => undefined);",
    specs: [INGRESS],
  },
  {
    n: 42,
    label: "P1 durable — 재시도 스캔을 제거한다(이번 response 후보만 본다)",
    file: COORDINATOR,
    from: '      .filter((row) => remediationStateOf(row.value) === "completion")',
    to: "      .filter(() => false)",
    specs: [COORD],
  },
  {
    n: 43,
    label: "P1 durable — completion 후보에도 일반 refetch 를 허용한다",
    file: DB,
    from: '  if (state === "completion" || state === "unknown") return false;',
    to: "",
    specs: [COORD, INGRESS],
  },
  {
    n: 44,
    label: "P1 durable — completion 후보를 durable 하게 굳히지 않는다",
    file: COORDINATOR,
    from: "        value: COMPLETION_DRAIN_PENDING,",
    to: "        value: REMEDIATION_PENDING,",
    specs: [COORD],
  },
  {
    n: 45,
    label: "P1 durable — unknown marker 를 안전으로 본다(fail open)",
    file: DB,
    from: '  return "unknown";',
    to: '  return "none";',
    specs: [COORD],
  },
];

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * **shell 을 거치지 않는다.** `shell: true` 로 `pnpm exec vitest` 를 부르면 Windows 의
 * `.cmd` 중첩 실행이 셸마다 다르게 깨진다 — 어떤 셸에서는 Vitest 요약을 아예 못 받아
 * 모든 행이 `GREEN(!)` 으로 보이고(= 방어되지 않은 것처럼), 그게 그대로 증거가 된다(독립 재리뷰 P2-4).
 * 그래서 **현재 node 실행 파일로 vitest 의 JS entry 를 직접** 돌린다. 셸 독립이다.
 */
const run = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    ...(cwd ? { cwd } : {}),
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });

const WEB_DIR = fileURLToPath(new URL("../apps/web", import.meta.url));
// `vitest/vitest.mjs` 는 exports 에 없다 — package.json 을 풀고 `bin` 을 붙여 실제 경로를 만든다.
const VITEST_PKG = createRequire(new URL("../apps/web/package.json", import.meta.url)).resolve(
  "vitest/package.json",
);
const VITEST_ENTRY = join(
  dirname(VITEST_PKG),
  JSON.parse(readFileSync(VITEST_PKG, "utf8")).bin.vitest,
);

/**
 * **색을 끄고 받는다.** 셸에 따라 Vitest 가 ANSI 를 섞어 내보내면 `Tests  N failed` 사이에
 * escape 시퀀스가 끼어 요약 파싱이 통째로 실패한다 — 그러면 모든 행이 `GREEN(!)` 으로 보여
 * **방어되지 않은 것처럼** 기록된다(독립 재리뷰 P2-2 가 그 상태를 관측했다).
 * 환경 변수로 한 번, 파싱 전에 strip 으로 또 한 번 막는다.
 */
const runVitest = (specs) =>
  run(process.execPath, [VITEST_ENTRY, "run", ...specs], WEB_DIR, {
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: "1",
  });

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const stripAnsi = (text) => text.replace(ANSI, "");

const wanted = process.argv.slice(2).map(Number);
const rows = wanted.length ? TABLE.filter((row) => wanted.includes(row.n)) : TABLE;
let survivors = 0;

for (const row of rows) {
  const before = sha(row.file);
  run("node", ["scripts/mutate.mjs", "snapshot", row.file]);
  const source = readFileSync(row.file, "utf8");
  if (!source.includes(row.from)) {
    console.log(`#${row.n} ✗ 앵커 미일치 — ${row.label}`);
    survivors += 1;
    continue;
  }
  writeFileSync(row.file, source.replace(row.from, row.to));

  let output = "";
  try {
    output = runVitest(row.specs);
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const clean = stripAnsi(output);
  // 공백 수에 기대지 않는다 — 셸·버전에 따라 정렬과 색이 달라진다.
  const matched = /Tests\s+\d+\s+(?:failed|passed|skipped).*/.exec(clean)?.[0]?.trim();
  // **실제 Vitest 요약을 받지 못하면 RED 로 치지 않는다.** 실행이 깨진 것을 "방어됨"으로 읽으면
  // 증거 자체가 거짓이 된다(독립 재리뷰 P2-4 가 정확히 그 상태를 지적했다).
  const summary = matched ?? "(요약 없음 — 실행 실패로 간주)";
  const failed = matched !== undefined && /(\d+) failed/.test(summary);
  const names = [...clean.matchAll(/FAIL\s+\S+ > (.+)/g)]
    .map((match) => match[1].trim())
    .filter((name, index, all) => all.indexOf(name) === index);

  run("node", ["scripts/mutate.mjs", "restore", row.file]);
  const after = sha(row.file);
  if (!failed) survivors += 1;
  console.log(
    [
      `#${row.n} ${failed ? "RED" : "GREEN(!)"} ${row.label}`,
      `    ${summary}`,
      ...names.slice(0, 2).map((name) => `    ↳ ${name}`),
      `    sha ${before.slice(0, 12)} → ${after.slice(0, 12)} ${before === after ? "일치" : "불일치(!)"}`,
    ].join("\n"),
  );
}
run("node", ["scripts/mutate.mjs", "verify"]);
if (survivors) {
  console.log(`\n생존 mutation ${survivors}건 — 방어되지 않았다.`);
  process.exitCode = 1;
}

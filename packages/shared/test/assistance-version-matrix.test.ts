import { describe, expect, it } from "vitest";
import {
  ASSISTANCE_PROVENANCE,
  ASSISTANCE_PROVENANCE_VERSIONS,
  isAllowedAssistanceVersion,
} from "../src/assistance";
import { SUPPORTED_RULES_BUNDLES } from "../src/rules-version";

/**
 * F-3 fixup — provenance ↔ rules_version 허용집합의 **단일 원천**.
 *
 * DB `ck_planned_assistance_version_matrix`, api service guard, factory 가 모두 이 표를 쓴다.
 * 하나만 넓어지면 그쪽이 우회 경로가 되어 provenance 를 믿는 safe predicate 가 오염된다.
 */

describe("ASSISTANCE_PROVENANCE_VERSIONS", () => {
  it("모든 provenance 에 허용 버전이 정의돼 있다 — 빠지면 그 값이 영원히 거부된다", () => {
    expect(Object.keys(ASSISTANCE_PROVENANCE_VERSIONS).sort()).toEqual(
      [...ASSISTANCE_PROVENANCE].sort(),
    );
    for (const versions of Object.values(ASSISTANCE_PROVENANCE_VERSIONS)) {
      expect(versions.length).toBeGreaterThan(0);
    }
  });

  it("허용 버전은 전부 지원 bundle 이다", () => {
    for (const versions of Object.values(ASSISTANCE_PROVENANCE_VERSIONS)) {
      for (const version of versions) {
        expect(SUPPORTED_RULES_BUNDLES).toContain(version);
      }
    }
  });

  it("legacy_performed 만 2026.08.1 을 갖는다 — 그 시절의 사실이라 옮길 수 없다", () => {
    expect(ASSISTANCE_PROVENANCE_VERSIONS.legacy_performed).toEqual(["2026.08.1"]);
    expect(ASSISTANCE_PROVENANCE_VERSIONS.native).not.toContain("2026.08.1");
    expect(ASSISTANCE_PROVENANCE_VERSIONS.remediated).not.toContain("2026.08.1");
  });

  it("remediated 는 hotfix bundle 하나뿐이다", () => {
    expect(ASSISTANCE_PROVENANCE_VERSIONS.remediated).toEqual(["2026.08.2"]);
  });
});

describe("isAllowedAssistanceVersion", () => {
  const valid: Array<[string, string]> = [
    ["native", "2026.08.2"],
    ["native", "2026.09.0"],
    ["native", "2026.09.1"],
    ["remediated", "2026.08.2"],
    ["legacy_performed", "2026.08.1"],
  ];
  const invalid: Array<[string, string]> = [
    ["native", "2026.08.1"],
    ["remediated", "2026.08.1"],
    ["remediated", "2026.09.0"],
    ["remediated", "2026.09.1"],
    ["legacy_performed", "2026.08.2"],
    ["legacy_performed", "2026.09.0"],
    ["legacy_performed", "2026.09.1"],
  ];

  it.each(valid)("%s + %s → 허용", (provenance, version) => {
    expect(isAllowedAssistanceVersion(provenance as "native", version)).toBe(true);
  });

  it.each(invalid)("%s + %s → 거부", (provenance, version) => {
    expect(isAllowedAssistanceVersion(provenance as "native", version)).toBe(false);
  });

  it("지원 bundle × provenance 전 조합에서 valid/invalid 목록이 빠짐없다", () => {
    // 새 bundle 을 추가하고 표를 안 고치면 여기서 잡힌다.
    const covered = new Set([...valid, ...invalid].map(([p, v]) => `${p}:${v}`));
    for (const provenance of ASSISTANCE_PROVENANCE) {
      for (const version of SUPPORTED_RULES_BUNDLES) {
        expect(covered.has(`${provenance}:${version}`)).toBe(true);
      }
    }
  });

  it("unknown 버전은 fail closed — false 가 아니라 throw 다", () => {
    // false 로 조용히 떨어뜨리면 "거부됨"과 "모르는 버전"을 구분할 수 없다.
    for (const provenance of ASSISTANCE_PROVENANCE) {
      expect(() => isAllowedAssistanceVersion(provenance, "9999.99.9")).toThrow(RangeError);
    }
  });
});

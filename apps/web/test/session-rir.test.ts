/**
 * RIR 입력 계약(FEATURES_UX F1-1).
 *
 * 고정하는 두 가지.
 *  1) 범위 밖(7, -1, 12 …) 값은 **UI 가 만들 수 없다** — 입력이 거부되고 값이 바뀌지 않는다.
 *  2) 미입력은 끝까지 `null` 이다. `0` 으로 바뀌면 엔진이 "RIR 0 = 실패 직전"으로 읽어
 *     무게를 낮추는 판정을 내린다(원래는 RIR 축 판정을 **보류**해야 한다).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlannedSet } from "../lib/api";
import { RirField } from "../components/session/RirField";
import { RirSheet } from "../components/session/RirSheet";
import { SetRow } from "../components/session/SetRow";
import {
  RIR_CHOICES,
  RIR_MAX,
  RIR_MIN,
  parseRirChoice,
  parseRirText,
  rirText,
  stepRir,
} from "../components/session/rir";
import { resolveValues, setPrefill } from "../components/session/set-rules";

describe("parseRirText (숫자 직접 입력)", () => {
  it("0~6 을 그대로 받는다", () => {
    for (const value of [0, 1, 2, 3, 4, 5, 6]) {
      expect(parseRirText(String(value))).toEqual({ accepted: true, value });
    }
  });

  it("범위 밖·숫자 아님은 거부한다(값이 바뀌지 않는다)", () => {
    for (const text of ["7", "9", "-1", "12", "2.5", "a", "０"]) {
      expect(parseRirText(text).accepted, `${text} 는 거부돼야 한다`).toBe(false);
    }
  });

  it("빈 문자열은 '모름'이고 0 이 아니다", () => {
    expect(parseRirText("")).toEqual({ accepted: true, value: null });
    expect(parseRirText("   ")).toEqual({ accepted: true, value: null });
    expect(parseRirText("").value).not.toBe(0);
  });

  it("범위 상수는 엔진의 clamp(0, 6) 과 같다", () => {
    expect([RIR_MIN, RIR_MAX]).toEqual([0, 6]);
    expect(RIR_CHOICES).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("stepRir (↑/↓ 키, AC-RIR-6)", () => {
  it("값이 있으면 ±1 한다", () => {
    expect(stepRir(2, 1)).toBe(3);
    expect(stepRir(2, -1)).toBe(1);
  });

  it("0 과 6 에서 멈춘다(순환하지 않는다)", () => {
    expect(stepRir(6, 1)).toBe(6);
    expect(stepRir(0, -1)).toBe(0);
  });

  it("비어 있으면 아무 일도 하지 않는다(0 이 생기지 않는다)", () => {
    expect(stepRir(null, 1)).toBeNull();
    expect(stepRir(null, -1)).toBeNull();
  });
});

describe("parseRirChoice / rirText (드롭다운)", () => {
  it("'모름' 선택은 null 이다", () => {
    expect(parseRirChoice("")).toBeNull();
  });

  it("고른 값이 그대로 값이 된다", () => {
    expect(parseRirChoice("0")).toBe(0);
    expect(parseRirChoice("6")).toBe(6);
  });

  it("목록 밖 값은 미입력으로 떨어진다(0 으로 바뀌지 않는다)", () => {
    expect(parseRirChoice("7")).toBeNull();
    expect(parseRirChoice("nope")).toBeNull();
  });

  it("값 → 문자열은 미입력을 빈칸으로 되돌린다", () => {
    expect(rirText(null)).toBe("");
    expect(rirText(0)).toBe("0");
    expect(rirText(3)).toBe("3");
  });
});

describe("미입력 RIR 은 기록에 들어가지 않는다", () => {
  const set: PlannedSet = {
    id: "ps_1",
    exercise_id: "e_bench_press",
    set_no: 1,
    target_reps_low: 8,
    target_reps_high: 10,
    target_rir: 2,
    rest_sec: 120,
    recommended_weight: 62.5,
    recommended_reps: 9,
    reason_code: "WEIGHT_UP_REP_TARGET_MET",
    confidence: 0.85,
    rules_version: "2026.08.1",
  };

  it("프리필에 RIR 축이 없다(목표 RIR 을 기록값으로 쓰지 않는다)", () => {
    expect(setPrefill("weighted", set)).toEqual({ weight: 62.5, reps: 9, timeSec: null });
  });

  it("RIR 을 비운 채 완료 체크하면 기록값이 null 이다(0 아님)", () => {
    const resolved = resolveValues(
      "weighted",
      { weight: 62.5, reps: 9, rir: null, timeSec: null },
      setPrefill("weighted", set),
    );

    expect(resolved.rir).toBeNull();
    expect(resolved.rir).not.toBe(0);
  });

  it("RIR 0 을 실제로 고른 경우는 그대로 0 으로 기록한다(미입력과 구분된다)", () => {
    const resolved = resolveValues(
      "weighted",
      { weight: 62.5, reps: 9, rir: 0, timeSec: null },
      setPrefill("weighted", set),
    );

    expect(resolved.rir).toBe(0);
  });
});

describe("RirField 렌더 (F1-1 2차 개정: 단일 입력 + 셰브론)", () => {
  const html = (props: Partial<Parameters<typeof RirField>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(RirField, {
        id: "set-ps_1-rir",
        setLabel: "벤치프레스 1세트",
        value: null,
        targetRir: 2,
        describedById: undefined,
        onChange: () => {},
        ...props,
      }),
    );

  it("입력칸을 하나만 낸다(입력칸 + 드롭다운 2개로 나누지 않는다)", () => {
    const markup = html();
    expect((markup.match(/<input/g) ?? []).length).toBe(1);
    expect(markup).not.toContain("<select");
    expect(markup).toContain('inputMode="numeric"');
  });

  /*
    datalist 는 iOS 에서 **탭으로 목록을 여는 경로가 없다**(UX_STATES §2.4.2 에서 탈락한 안).
    목록은 셰브론 → 하단 시트로만 연다.
  */
  it("datalist 를 쓰지 않는다(탈락한 안)", () => {
    const markup = html();
    expect(markup).not.toContain("<datalist");
    expect(markup).not.toContain("list=");
  });

  it("칸 안쪽 우측에 시트를 여는 셰브론이 있고, Tab 순서 밖이다(AC-RIR-7)", () => {
    const markup = html();
    expect(markup).toContain('aria-label="벤치프레스 1세트 RIR 고르기"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('tabindex="-1"');
  });

  it("목표 RIR 문구를 aria-describedby 로 연결한다(AC-RIR-4)", () => {
    expect(html({ describedById: "set-ps_1-rir-target" })).toContain(
      'aria-describedby="set-ps_1-rir-target"',
    );
    expect(html({ describedById: undefined })).not.toContain("aria-describedby");
  });

  it("미입력이면 칸이 비어 있다(0 이 미리 들어가 있지 않다)", () => {
    expect(html({ value: null })).toContain('value=""');
    expect(html({ value: 0 })).toContain('value="0"');
  });
});

describe("RirSheet (M-7 RIR 고르기)", () => {
  const html = (props: Partial<Parameters<typeof RirSheet>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(RirSheet, {
        open: true,
        sheetId: "set-ps_1-rir-sheet",
        value: null,
        targetRir: 2,
        onSelect: () => {},
        onClose: () => {},
        ...props,
      }),
    );

  /**
   * 칩 하나의 **보이는 글자**. 태그를 벗겨서 본다.
   * 예전에는 `>([^<]*)<` 로 여는 태그 바로 뒤 텍스트만 봤는데, 그건 마크업 **모양**에 묶인 단언이라
   * 숫자를 `<span class="font-mono tabular-nums">` 로 감싸자(§4 모노 숫자) 값이 전부 빈 문자열이 됐다.
   * 사용자에게 보이는 글자는 그대로였다 — 그래서 의도(라벨·선택 상태·목표 표시)는 유지하고
   * 래핑 방식에만 덜 묶이게 바꿨다. 약화가 아니라는 것은 뮤테이션으로 확인했다.
   */
  const chipTexts = (markup: string): string[] =>
    [...markup.matchAll(/<button[^>]*aria-pressed="(?:true|false)"[\s\S]*?<\/button>/g)].map((m) =>
      m[0].replace(/<[^>]*>/g, "").trim(),
    );

  const selectedChipText = (markup: string): string | undefined =>
    markup
      .match(/<button[^>]*aria-pressed="true"[\s\S]*?<\/button>/)?.[0]
      .replace(/<[^>]*>/g, "")
      .trim();

  it("칩 8개(모름 + 0~6)를 낸다 — 7 은 고를 수 없다", () => {
    // targetRir 기본값이 2 라 그 칩에는 '목표' 배지가 붙어 있다.
    expect(chipTexts(html())).toEqual(["모름", "0", "1", "2목표", "3", "4", "5", "6"]);
  });

  it("현재 값 칩이 선택 상태다(미입력이면 '모름')", () => {
    expect(selectedChipText(html({ value: null }))).toBe("모름");
    expect(selectedChipText(html({ value: 3 }))).toBe("3");
  });

  it("목표에 해당하는 칩에 '목표' 표시를 둔다", () => {
    expect(chipTexts(html({ targetRir: 2 }))).toContain("2목표");
    expect(chipTexts(html({ targetRir: 4 }))).toContain("4목표");
    expect(html({ targetRir: null })).not.toContain("목표");
  });

  it("무엇을 묻는지 보조 문구로 설명한다", () => {
    expect(html()).toContain(
      "세트를 끝냈을 때 몇 회 더 할 수 있었는지예요. 잘 모르겠으면 비워 두세요.",
    );
  });

  it("닫혀 있으면 DOM 에 아무것도 남기지 않는다", () => {
    expect(html({ open: false })).toBe("");
  });
});

describe("목표 RIR 표기", () => {
  const set: PlannedSet = {
    id: "ps_2",
    exercise_id: "e_bench_press",
    set_no: 1,
    target_reps_low: 8,
    target_reps_high: 10,
    target_rir: 2,
    rest_sec: 120,
    recommended_weight: 62.5,
    recommended_reps: 9,
    reason_code: "WEIGHT_UP_REP_TARGET_MET",
    confidence: 0.85,
    rules_version: "2026.08.1",
  };

  const row = (overrides: Partial<PlannedSet> = {}) =>
    renderToStaticMarkup(
      createElement(SetRow, {
        set: { ...set, ...overrides },
        kind: "weighted" as const,
        exerciseName: "벤치프레스",
        fallbackWeight: null,
        previous: null,
        readOnly: false,
        expanded: false,
        onToggleExpand: () => {},
        onComplete: () => {},
        onEdit: () => {},
        onUncomplete: () => {},
      }),
    );

  it("세트 행 보조 줄에 목표 RIR 이 함께 보인다", () => {
    expect(row()).toContain("RIR 목표 2");
  });

  it("목표가 없는 세트에는 표기 자체를 만들지 않는다(`목표 null` 금지)", () => {
    expect(row({ target_rir: null })).not.toContain("RIR 목표");
  });

  /*
    폭 예산(§2.4.1)상 "목표 2" 를 입력칸 오른쪽에 나란히 둘 자리가 없어 보조 줄에 둔다.
    대신 **aria-describedby 로 입력칸에 연결**해 스크린리더가 목표를 함께 읽게 한다(AC-RIR-4).
  */
  it("목표 문구가 RIR 입력칸에 aria-describedby 로 연결된다(AC-RIR-4)", () => {
    const markup = row();
    expect(markup).toContain('id="set-ps_2-rir-target"');
    expect(markup).toContain('aria-describedby="set-ps_2-rir-target"');
  });

  it("목표가 없으면 연결도 없다(빈 id 를 가리키지 않는다)", () => {
    expect(row({ target_rir: null })).not.toContain("rir-target");
  });
});

describe("시간 종목(AC-E-4)", () => {
  const timeSet: PlannedSet = {
    id: "ps_time",
    exercise_id: "e_plank",
    set_no: 1,
    target_reps_low: null,
    target_reps_high: null,
    target_rir: null,
    rest_sec: 60,
    target_time_low_sec: 40,
    target_time_high_sec: 60,
    recommended_weight: null,
    recommended_reps: null,
    reason_code: "TIME_HOLD",
    confidence: 0.6,
    rules_version: "2026.08.1",
  };

  it("RIR 입력이 DOM 에 없다", () => {
    const markup = renderToStaticMarkup(
      createElement(SetRow, {
        set: timeSet,
        kind: "time" as const,
        exerciseName: "플랭크",
        fallbackWeight: null,
        previous: null,
        readOnly: false,
        expanded: false,
        onToggleExpand: () => {},
        onComplete: () => {},
        onEdit: () => {},
        onUncomplete: () => {},
      }),
    );

    expect(markup).not.toContain("RIR");
    expect(markup).not.toContain("<select");
  });
});

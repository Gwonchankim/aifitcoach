"use client";

/**
 * 온보딩 6스텝의 입력 UI (UX_STATES §2.1, §6).
 * 상태는 전부 OnboardingWizard 가 가지고 있고 여기는 표시·이벤트만 한다.
 */
import { Card, Chip, Input } from "../ui";
import {
  DAYS_OPTIONS,
  EQUIPMENT_OPTIONS,
  EXPERIENCE_OPTIONS,
  GOAL_OPTIONS,
  MINUTES_OPTIONS,
  type OnboardingDraft,
  SEX_OPTIONS,
  toggleEquipment,
} from "./draft";
import { PAIN_AREAS, type PainArea, togglePainArea, toggleNone } from "./pain-areas";

export type StepProps = {
  draft: OnboardingDraft;
  onChange: (patch: Partial<OnboardingDraft>) => void;
};

/** 단일 선택 칩 묶음. 그룹 이름을 legend 로 주어 스크린리더가 맥락을 읽게 한다. */
function ChipGroup({
  legend,
  hideLegend = false,
  children,
}: {
  legend: string;
  hideLegend?: boolean;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="border-0 p-0">
      <legend className={hideLegend ? "sr-only" : "mb-2 text-sm font-medium text-fg-muted"}>
        {legend}
      </legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

export function ProfileStep({ draft, onChange }: StepProps) {
  return (
    <div className="flex flex-col gap-5">
      <ChipGroup legend="성별">
        {SEX_OPTIONS.map((option) => (
          <Chip
            key={option.value}
            selected={draft.sex === option.value}
            onClick={() => onChange({ sex: option.value })}
          >
            {option.label}
          </Chip>
        ))}
      </ChipGroup>

      <Input
        id="onboarding-birth-year"
        label="출생연도"
        inputMode="numeric"
        placeholder="1995"
        value={draft.birth_year}
        onChange={(event) => onChange({ birth_year: event.target.value })}
      />
      <Input
        id="onboarding-height"
        label="키 (cm)"
        unit="cm"
        inputMode="decimal"
        placeholder="172"
        value={draft.height_cm}
        onChange={(event) => onChange({ height_cm: event.target.value })}
      />
      <Input
        id="onboarding-weight"
        label="체중 (kg)"
        unit="kg"
        inputMode="decimal"
        placeholder="70"
        value={draft.weight_kg}
        onChange={(event) => onChange({ weight_kg: event.target.value })}
        hint="비워 둬도 계획을 만들 수 있어요."
      />
    </div>
  );
}

/**
 * 목표 3종은 설명이 붙는 **라디오 카드**다(칩이 아니다) → 모서리는 카드 반경 3px.
 * Chip 기본 반경보다 뒤에 `rounded-card` 를 전달해 카드 반경을 적용한다(DESIGN_TOKENS §5).
 */
export function GoalStep({ draft, onChange }: StepProps) {
  return (
    <ChipGroup legend="목표" hideLegend>
      {GOAL_OPTIONS.map((option) => (
        <Chip
          key={option.value}
          selected={draft.goal === option.value}
          onClick={() => onChange({ goal: option.value })}
          className="w-full flex-col items-start justify-center gap-0.5 rounded-card px-5 py-3 text-left"
        >
          <span className="text-base">{option.label}</span>
          {/* 보조 설명은 캡션이다 → `muted`(§2.1). 자식이 자기 색을 가지므로 부모의 `!` 와 다투지 않는다. */}
          <span className="text-xs font-normal text-fg-muted">{option.description}</span>
        </Chip>
      ))}
    </ChipGroup>
  );
}

export function DaysStep({ draft, onChange }: StepProps) {
  return (
    <div className="flex flex-col gap-3">
      <ChipGroup legend="주당 운동 일수" hideLegend>
        {DAYS_OPTIONS.map((days) => (
          <Chip
            key={days}
            selected={draft.days_per_week === days}
            onClick={() => onChange({ days_per_week: days })}
            className="min-w-tap-lg"
            aria-label={`주 ${days}일`}
          >
            {/* 숫자만 모노 + tabular-nums 로 뽑는다(§4). 한글("주"·"일")은 본문 폰트 그대로 —
                JetBrains Mono 에 한글 글리프가 없어 통째로 감싸면 폴백 고정폭으로 튄다.
                보이는 글자와 접근 이름("주 3일")은 그대로다. */}
            주 <span className="font-mono">{days}</span>일
          </Chip>
        ))}
      </ChipGroup>
      <p className="text-sm text-ink-2">회복일을 사이에 두고 요일을 배치해 드려요.</p>
    </div>
  );
}

export function MinutesStep({ draft, onChange }: StepProps) {
  return (
    <div className="flex flex-col gap-3">
      <ChipGroup legend="1회 운동 시간" hideLegend>
        {MINUTES_OPTIONS.map((minutes) => (
          <Chip
            key={minutes}
            selected={draft.minutes_per_day === minutes}
            onClick={() => onChange({ minutes_per_day: minutes })}
            className="min-w-tap-lg"
            aria-label={`${minutes}분`}
          >
            <span className="font-mono">{minutes}</span>분
          </Chip>
        ))}
      </ChipGroup>
      <p className="text-sm text-ink-2">세트 사이 휴식까지 포함한 시간이에요.</p>
    </div>
  );
}

/**
 * 운동 경력 (F0). 이 값은 계획의 종목 난도에 실제로 반영되므로 기본값으로 넘기지 않고 직접 묻는다.
 * 보조 문구는 기간·익숙함만 말한다 — 성과·의료 표현은 쓰지 않는다.
 */
export function ExperienceStep({ draft, onChange }: StepProps) {
  return (
    <div className="flex flex-col gap-3">
      <ChipGroup legend="운동 경력" hideLegend>
        {EXPERIENCE_OPTIONS.map((option) => (
          <Chip
            key={option.value}
            selected={draft.experience_level === option.value}
            onClick={() => onChange({ experience_level: option.value })}
            className="w-full flex-col items-start justify-center gap-0.5 rounded-card px-5 py-3 text-left"
          >
            <span className="text-base">{option.label}</span>
            <span className="text-xs font-normal text-fg-muted">{option.description}</span>
          </Chip>
        ))}
      </ChipGroup>
      <p className="text-sm text-ink-2">경력에 맞는 난도의 종목을 골라 드려요.</p>
    </div>
  );
}

export function EquipmentStep({ draft, onChange }: StepProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-2">여러 개 고를 수 있어요. 고른 장비로만 계획을 짜요.</p>
      <ChipGroup legend="보유 장비" hideLegend>
        {EQUIPMENT_OPTIONS.map((option) => (
          <Chip
            key={option.value}
            selected={draft.equipment.includes(option.value)}
            onClick={() => onChange({ equipment: toggleEquipment(draft.equipment, option.value) })}
          >
            {option.label}
          </Chip>
        ))}
      </ChipGroup>
      {/* 최소 1개를 강제하지 않는다 — 전부 해제해도 진행할 수 있고 빈 배열은 "전체 허용"이다. */}
      {draft.equipment.length === 0 ? (
        <p role="status" className="text-sm text-ink-2">
          아무것도 고르지 않으면 모든 장비를 쓸 수 있다고 보고 계획을 짜요. 집에서만 운동한다면
          &lsquo;맨몸&rsquo;만 골라 주세요.
        </p>
      ) : null}
    </div>
  );
}

/**
 * 통증 부위 스텝 (F0-1 / UX_STATES §6).
 * 자유 텍스트 입력이 없다 — 칩 8개 + "해당 없음"만 있다(AC-P-1).
 */
export function PainStep({ draft, onChange }: StepProps) {
  const { pain } = draft;
  const selectedCount = pain.areas.length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-2">
        선택하신 부위에 부담이 큰 운동을 계획에서 빼 드려요. 여러 개 고를 수 있어요.
      </p>

      <ChipGroup legend="불편한 부위" hideLegend>
        {PAIN_AREAS.map((area) => (
          <Chip
            key={area.value}
            selected={pain.areas.includes(area.value as PainArea)}
            aria-label={area.srLabel}
            onClick={() => onChange({ pain: togglePainArea(pain, area.value as PainArea) })}
          >
            {area.label}
          </Chip>
        ))}
      </ChipGroup>

      <Chip
        selected={pain.none}
        aria-label="해당 없음, 불편한 곳 없음"
        className="self-start"
        onClick={() => onChange({ pain: toggleNone(pain) })}
      >
        해당 없음
      </Chip>

      {selectedCount > 0 ? (
        <p role="status" className="text-sm font-medium text-fg">
          {selectedCount}곳 선택됨
        </p>
      ) : null}

      <Card tone="raised" className="flex flex-col gap-2">
        <p className="text-sm text-fg">
          목록에 없는 부위는 지금은 선택할 수 없어요. 통증이 심하거나 오래간다면 전문가와 상담해
          주세요.
        </p>
        <p className="text-sm text-fg-muted">일반적인 회피 가이드이며 의료적 조언이 아니에요.</p>
      </Card>
    </div>
  );
}

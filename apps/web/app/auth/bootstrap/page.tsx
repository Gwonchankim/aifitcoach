"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, api } from "../../../lib/api";
import { Button, Card, Checkbox, Input } from "../../../components/ui";

type Sex = "male" | "female" | "other";
type Goal = "diet" | "hypertrophy" | "strength";
type Experience = "beginner" | "intermediate" | "advanced";

export default function OwnerBootstrapPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [ownerCode, setOwnerCode] = useState("");
  const [sex, setSex] = useState<Sex>("other");
  const [birthYear, setBirthYear] = useState("1990");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [bodyFatPct, setBodyFatPct] = useState("");
  const [goal, setGoal] = useState<Goal>("hypertrophy");
  const [experience, setExperience] = useState<Experience>("beginner");
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bootstrap = useMutation({
    mutationFn: () =>
      api.ownerBootstrap({
        owner_code: ownerCode,
        profile: {
          sex,
          birth_year: Number(birthYear),
          height_cm: Number(heightCm),
          weight_kg: Number(weightKg),
          body_fat_pct: bodyFatPct === "" ? null : Number(bodyFatPct),
          goal,
          experience_level: experience,
        },
        consents: [{ type: "privacy_collection", version: "2026-08-17-draft", granted: consented }],
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      router.replace("/onboarding");
    },
    onError: (reason) => {
      setError(
        reason instanceof ApiError && reason.status === 409
          ? "이미 등록된 소유자 계정이 있어요. 복구 코드로 로그인해 주세요."
          : reason instanceof ApiError && reason.status === 401
            ? "복구 코드를 확인해 주세요."
            : "입력한 정보를 다시 확인해 주세요.",
      );
    },
  });

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-4 pb-safe-bottom">
      <header className="flex flex-col gap-2 pt-4">
        <p className="text-sm font-semibold text-fg-muted">최초 설정</p>
        <h1 className="text-2xl font-bold text-fg">내 기록을 안전하게 시작하기</h1>
        <p className="text-sm text-ink-2">
          아래 정보와 동의를 한 번에 등록합니다. 운동 계획은 다음 화면에서 만들 수 있어요.
        </p>
      </header>
      <Card>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            bootstrap.mutate();
          }}
        >
          <Input
            id="bootstrap-owner-code"
            label="소유자 복구 코드"
            type="password"
            autoComplete="new-password"
            value={ownerCode}
            onChange={(event) => setOwnerCode(event.target.value)}
            minLength={24}
            maxLength={256}
            required
            hint="비밀번호 관리자에 보관할 32바이트 이상 무작위 코드입니다. 잃어버리면 기록을 되찾을 수 없습니다."
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-fg-muted">성별</legend>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["male", "남성"],
                  ["female", "여성"],
                  ["other", "응답 안 함/기타"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={sex === value ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setSex(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <Input
              id="birth-year"
              label="출생 연도"
              type="number"
              inputMode="numeric"
              min={1900}
              max={2026}
              value={birthYear}
              onChange={(event) => setBirthYear(event.target.value)}
              required
            />
            <Input
              id="height-cm"
              label="키 (cm)"
              type="number"
              inputMode="decimal"
              min={100}
              max={250}
              value={heightCm}
              onChange={(event) => setHeightCm(event.target.value)}
              required
            />
            <Input
              id="weight-kg"
              label="체중 (kg)"
              type="number"
              inputMode="decimal"
              min={30}
              max={300}
              value={weightKg}
              onChange={(event) => setWeightKg(event.target.value)}
              required
            />
            <Input
              id="body-fat-pct"
              label="체지방률 (선택, %)"
              type="number"
              inputMode="decimal"
              min={1}
              max={70}
              value={bodyFatPct}
              onChange={(event) => setBodyFatPct(event.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-fg-muted">목표</legend>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["diet", "다이어트"],
                  ["hypertrophy", "근비대"],
                  ["strength", "근력"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={goal === value ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setGoal(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-fg-muted">운동 경험</legend>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["beginner", "처음"],
                  ["intermediate", "경험 있음"],
                  ["advanced", "숙련"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={experience === value ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setExperience(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </fieldset>
          <section className="flex flex-col gap-2 rounded-control border border-border bg-raised p-3">
            <h2 className="text-base font-semibold text-fg">
              개인정보 수집·이용 안내 (검토 전 초안)
            </h2>
            <p className="text-sm text-ink-2">
              성별·출생 연도·키·체중·체지방률, 이후 입력하는 통증과 운동 기록을 맞춤 운동 계획과
              기록 제공을 위해 저장합니다. 서비스 운영자인 본인은 오류 대응과 파일럿 분석을 위해
              기록을 조회할 수 있습니다. 내 정보에서 동의 이력·JSON 내보내기·삭제를 요청할 수
              있습니다.
            </p>
            <p className="text-xs text-fg-muted">
              이 문안은 법률 검토 전의 개인 사용 단계 초안입니다.
            </p>
            <Checkbox
              label="위 수집·이용에 동의합니다"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
            />
          </section>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" fullWidth disabled={bootstrap.isPending || !consented}>
            {bootstrap.isPending ? "등록하는 중…" : "동의하고 시작하기"}
          </Button>
        </form>
      </Card>
      <p className="text-center text-sm text-fg-muted">
        이미 등록했나요?{" "}
        <Link className="font-semibold text-primary underline" href="/auth">
          로그인으로 돌아가기
        </Link>
      </p>
    </div>
  );
}

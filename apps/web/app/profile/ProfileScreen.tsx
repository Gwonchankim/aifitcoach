"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, setCsrfToken } from "../../lib/api";
import { Button, Card } from "../../components/ui";
import { isNotFound } from "../../lib/error-copy";
import { useOnline } from "../../lib/use-online";
import { SplitPreferenceFields } from "../../components/onboarding/SplitPreferenceFields";
import type { SplitPreference } from "../../components/onboarding/draft";
import { OfflinePreferenceStatus } from "../../components/onboarding/OfflinePreferenceStatus";

export function ProfileScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const online = useOnline();
  const [preference, setPreference] = useState<SplitPreference | null | undefined>(undefined);
  const profile = useQuery({ queryKey: ["auth", "me"], queryFn: api.me, retry: false });
  const program = useQuery({
    queryKey: ["program", "current"],
    queryFn: api.currentProgram,
    retry: false,
  });
  const savePreference = useMutation({
    mutationFn: (value: SplitPreference | null) => api.updateProfile({ split_preference: value }),
    onSuccess: (data) => {
      queryClient.setQueryData(["auth", "me"], data);
      setPreference(undefined);
    },
  });
  const selectedPreference =
    preference === undefined ? (profile.data?.split_preference ?? null) : preference;
  const staleProfile = profile.data != null && profile.isError;
  const preferenceDisabled = !online || staleProfile || savePreference.isPending;
  const exportData = useMutation({
    mutationFn: api.exportData,
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `aifitcoach-export-${data.exported_at.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    },
  });
  const deleteAccount = useMutation({
    mutationFn: api.deleteAccount,
    onSuccess: () => {
      setCsrfToken(null);
      queryClient.clear();
      router.replace("/auth");
    },
  });

  if (profile.isPending || (program.isPending && online))
    return online ? (
      <p className="text-sm text-fg-muted">설정을 불러오는 중이에요.</p>
    ) : (
      <OfflinePreferenceStatus online={false} stale={false} />
    );

  return (
    <div className="mt-3 flex flex-col gap-3">
      <OfflinePreferenceStatus
        online={online}
        stale={staleProfile}
        cachedAt={profile.data ? profile.dataUpdatedAt : undefined}
      />
      {profile.data ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <dt className="text-fg-muted">출생 연도</dt>
          <dd className="font-mono text-fg">{profile.data.birth_year}</dd>
          <dt className="text-fg-muted">키 / 체중</dt>
          <dd className="font-mono text-fg">
            {profile.data.height_cm}cm / {profile.data.weight_kg}kg
          </dd>
          <dt className="text-fg-muted">체지방률</dt>
          <dd className="font-mono text-fg">
            {profile.data.body_fat_pct == null ? "미입력" : `${profile.data.body_fat_pct}%`}
          </dd>
        </dl>
      ) : null}
      {profile.data ? (
        <Card className="flex flex-col gap-3">
          <SplitPreferenceFields
            value={selectedPreference}
            onChange={(value) => {
              setPreference(value);
              savePreference.reset();
            }}
            supported={profile.data.split_preference_supported}
            disabled={preferenceDisabled}
          />
          <div className="flex gap-2">
            <Button
              size="md"
              disabled={preferenceDisabled}
              onClick={() => {
                if (!preferenceDisabled) savePreference.mutate(selectedPreference);
              }}
            >
              선호 저장
            </Button>
            <Button
              size="md"
              variant="secondary"
              disabled={preferenceDisabled}
              onClick={() => {
                if (!preferenceDisabled) savePreference.mutate(null);
              }}
            >
              선호 지우기
            </Button>
          </div>
          {savePreference.isSuccess && online && !staleProfile ? (
            <p role="status" className="text-sm text-ink-2">
              {savePreference.data.split_preference === null
                ? "선호를 지웠어요. 새 계획은 기본 배치로 만들어요."
                : savePreference.data.split_preference_supported
                  ? "선호를 저장했어요. 새 계획을 만들 때 반영돼요."
                  : "선호를 저장했어요. 지금 계획 방식에서는 아직 적용되지 않고, 새 방식이 적용되는 계획부터 반영돼요."}
            </p>
          ) : null}
          {savePreference.isError && online && !staleProfile ? (
            <p role="alert" className="text-sm text-danger">
              선호를 저장하지 못했어요. 다시 시도해 주세요.
            </p>
          ) : null}
        </Card>
      ) : null}
      {!program.data && isNotFound(program.error) ? (
        <p className="text-sm text-ink-2">아직 만든 프로그램 설정이 없어요.</p>
      ) : program.data ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <dt className="text-fg-muted">목표</dt>
          <dd className="text-fg">{program.data.goal}</dd>
          <dt className="text-fg-muted">운동일</dt>
          <dd className="font-mono text-fg">주 {program.data.sessions.length}일</dd>
          <dt className="text-fg-muted">분할</dt>
          <dd className="text-fg">{program.data.split_type}</dd>
        </dl>
      ) : (
        <p role="alert" className="text-sm text-ink-2">
          지금은 프로그램 설정을 불러올 수 없어요.
        </p>
      )}
      <Card className="flex flex-col gap-2 bg-raised">
        <h3 className="text-base font-semibold text-fg">내 데이터</h3>
        <p className="text-sm text-ink-2">
          동의 이력과 현재 운동 기록을 JSON 파일로 받을 수 있습니다.
        </p>
        <Button
          variant="secondary"
          size="md"
          fullWidth
          disabled={exportData.isPending}
          onClick={() => exportData.mutate()}
        >
          {exportData.isPending ? "파일 준비 중…" : "내 데이터 내보내기"}
        </Button>
        <Button
          variant="danger"
          size="md"
          fullWidth
          disabled={deleteAccount.isPending}
          onClick={() => {
            if (window.confirm("계정을 삭제하면 즉시 접근이 차단됩니다. 계속할까요?")) {
              deleteAccount.mutate();
            }
          }}
        >
          계정과 기록 삭제 요청
        </Button>
        {exportData.isError || deleteAccount.isError ? (
          <p role="alert" className="text-sm text-danger">
            지금은 요청을 처리할 수 없어요. 잠시 뒤 다시 시도해 주세요.
          </p>
        ) : null}
      </Card>
    </div>
  );
}

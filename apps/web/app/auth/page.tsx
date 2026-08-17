"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, api } from "../../lib/api";
import { Button, Card, Input } from "../../components/ui";

export default function OwnerLoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [ownerCode, setOwnerCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const login = useMutation({
    mutationFn: () => api.ownerLogin({ owner_code: ownerCode }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      router.replace("/");
    },
    onError: (reason) => {
      setError(
        reason instanceof ApiError && reason.status === 401
          ? "복구 코드를 확인해 주세요."
          : "지금 로그인할 수 없어요. 잠시 뒤 다시 시도해 주세요.",
      );
    },
  });

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 p-4">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-semibold text-fg-muted">AIFITCOACH</p>
        <h1 className="text-2xl font-bold text-fg">내 기록으로 돌아가기</h1>
        <p className="text-sm text-ink-2">
          최초 설정 때 만든 소유자 복구 코드를 입력하세요. 코드는 이 기기에 저장하지 않습니다.
        </p>
      </header>
      <Card>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            login.mutate();
          }}
        >
          <Input
            id="owner-code"
            label="소유자 복구 코드"
            type="password"
            autoComplete="current-password"
            value={ownerCode}
            onChange={(event) => setOwnerCode(event.target.value)}
            minLength={24}
            maxLength={256}
            required
            hint={error ?? "32바이트 이상인 무작위 코드를 사용합니다."}
            invalid={error !== null}
          />
          <Button type="submit" size="lg" fullWidth disabled={login.isPending}>
            {login.isPending ? "확인하는 중…" : "로그인"}
          </Button>
        </form>
      </Card>
      <p className="text-center text-sm text-fg-muted">
        아직 최초 설정을 하지 않았나요?{" "}
        <Link className="font-semibold text-primary underline" href="/auth/bootstrap">
          처음 설정하기
        </Link>
      </p>
    </div>
  );
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { isNotFound } from "../../lib/error-copy";

export function ProfileScreen() {
  const program = useQuery({
    queryKey: ["program", "current"],
    queryFn: api.currentProgram,
    retry: false,
  });

  if (program.isPending) return <p className="text-sm text-fg-muted">설정을 불러오는 중이에요.</p>;

  if (!program.data && isNotFound(program.error)) {
    return <p className="text-sm text-ink-2">아직 만든 프로그램 설정이 없어요.</p>;
  }

  if (!program.data)
    return (
      <p role="alert" className="text-sm text-ink-2">
        지금은 설정을 불러올 수 없어요.
      </p>
    );

  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
      <dt className="text-fg-muted">목표</dt>
      <dd className="text-fg">{program.data.goal}</dd>
      <dt className="text-fg-muted">운동일</dt>
      <dd className="font-mono text-fg">주 {program.data.sessions.length}일</dd>
      <dt className="text-fg-muted">분할</dt>
      <dd className="text-fg">{program.data.split_type}</dd>
    </dl>
  );
}

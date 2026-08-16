import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "기록 · AIFITCOACH",
};

export default function HistoryPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-3 p-4">
      <h1 className="text-xl font-bold text-fg">기록</h1>
      <p className="text-sm text-ink-2">운동 기록과 추이는 여기에서 확인할 수 있어요.</p>
    </div>
  );
}

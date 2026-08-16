import type { Metadata } from "next";
import { HistoryScreen } from "../../components/history/HistoryScreen";

export const metadata: Metadata = {
  title: "기록 · AIFITCOACH",
};

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ exercise?: string }>;
}) {
  const { exercise } = await searchParams;
  return <HistoryScreen initialExerciseId={exercise} />;
}

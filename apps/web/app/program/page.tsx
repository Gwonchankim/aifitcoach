import type { Metadata } from "next";
import { ProgramScreen } from "./ProgramScreen";

export const metadata: Metadata = {
  title: "내 운동 계획 · AIFITCOACH",
};

export default function ProgramPage() {
  return <ProgramScreen />;
}

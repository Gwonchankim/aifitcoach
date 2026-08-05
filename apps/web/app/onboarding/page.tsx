import type { Metadata } from "next";
import { OnboardingWizard } from "../../components/onboarding/OnboardingWizard";

export const metadata: Metadata = {
  title: "운동 계획 만들기 · AIFITCOACH",
};

export default function OnboardingPage() {
  return <OnboardingWizard />;
}

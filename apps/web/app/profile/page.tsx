import type { Metadata } from "next";
import { ProfileScreen } from "./ProfileScreen";

export const metadata: Metadata = {
  title: "내 정보 · AIFITCOACH",
};

export default function ProfilePage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-3 p-4">
      <h1 className="text-xl font-bold text-fg">내 정보</h1>
      <section
        aria-labelledby="profile-program-settings"
        className="border border-border bg-surface p-3 rounded-card"
      >
        <h2 id="profile-program-settings" className="text-base font-semibold text-fg">
          프로그램 설정
        </h2>
        <ProfileScreen />
        <p className="mt-2 text-xs text-fg-muted">
          읽기 전용 화면이며 민감한 개인 정보와 결제 정보를 다루지 않아요.
        </p>
      </section>
    </div>
  );
}

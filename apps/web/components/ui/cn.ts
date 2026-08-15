import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["control", "card", "sheet"],
      shadow: ["card", "sheet"],
      spacing: ["tap", "tap-lg", "tap-xl", "safe-bottom", "action-bottom"],
      text: ["kicker", "kicker-lg", "metric", "timer"],
    },
  },
});

/** 클래스 이름 합치기(조건부 클래스·Tailwind 충돌 해소 지원). */
export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return twMerge(...values);
}

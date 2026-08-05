/**
 * 클래스 이름 합치기(조건부 클래스 지원). 외부 의존성 없이 최소 구현.
 * 사용법: cn("px-4", isActive && "bg-primary", className)
 */
export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}

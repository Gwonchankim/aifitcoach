/**
 * 하단 액션 바(F0-0): **"짧으면 따라 올라오고, 길면 고정"**.
 *
 *   <ActionBar className="mt-6">
 *     <Button variant="secondary" size="lg" className="shrink-0">이전</Button>
 *     <Button size="lg" fullWidth>다음</Button>
 *   </ActionBar>
 *
 * 동작 원리는 `position: sticky; bottom: 0` 하나다(JS 없음).
 *   - 콘텐츠가 짧아 스크롤이 없으면 → 바는 **문서 흐름 그대로** 콘텐츠 바로 아래에 온다(엄지 근처로 올라온다).
 *   - 콘텐츠가 길어 스크롤이 생기면 → 화면 하단에 **붙어서** 따라온다.
 *
 * 그래서 부모에서 **바를 아래로 밀어내는 레이아웃을 쓰면 안 된다**:
 *   ✗ `min-h-dvh flex-col` + 콘텐츠 `flex-1`  → 짧은 화면에서도 바가 화면 맨 아래로 내려가 가운데가 빈다.
 *   ✓ 콘텐츠 높이만큼만 자라는 컨테이너(`flex-1`/`mt-auto` 없음). 부모에 `overflow-hidden` 도 금지(sticky 무효).
 *
 * 길어서 고정됐을 때 아래 콘텐츠를 덮으므로 배경은 불투명(`bg-bg`)이다.
 * 아래 여백은 `pb-action-bottom` = max(safe-area, 12px) — 홈 인디케이터가 없는 기기에서도 맨 끝에 붙지 않는다.
 */
import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type ActionBarProps = HTMLAttributes<HTMLDivElement>;

export function ActionBar({ className, ...props }: ActionBarProps) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-10 flex gap-2 bg-bg pt-3 pb-action-bottom",
        // 바깥 여백(mt-*)은 호출부가 정한다 — 여기서 잡으면 화면마다 덮어쓰기 싸움이 난다.
        className,
      )}
      {...props}
    />
  );
}

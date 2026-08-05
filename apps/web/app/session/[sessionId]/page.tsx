/**
 * 오늘의 데일리 루틴 화면(F1~F7). 세션 id 는 경로에서 받는다
 * (대시보드 → [운동 시작] 진입).
 */
import { SessionScreen } from "../../../components/session/SessionScreen";

export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <SessionScreen sessionId={sessionId} />;
}

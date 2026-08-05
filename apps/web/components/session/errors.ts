/**
 * 에러 → 사용자 문구 매핑(UX_STATES §3).
 *
 * 규칙: 서버 `error.message`·`error.code` 를 화면에 노출하지 않는다.
 * 상태코드 + **액션 컨텍스트**로만 문구를 고른다(한국어 메시지 문자열 매칭 금지).
 */
import { ApiError } from "../../lib/api";

export type ErrorAction = "session" | "catalog" | "add" | "remove" | "swap" | "complete";

const NETWORK = "인터넷 연결이 불안정해요. 연결되면 자동으로 이어서 진행할게요.";
const SERVER = "잠시 문제가 있었어요. 다시 시도해 주세요.";
const SESSION_NOT_FOUND = "오늘 운동을 찾을 수 없어요. 대시보드에서 다시 시작해 주세요.";

/** E-10. 다른 기기에서 세션이 종료된 뒤 편집을 시도한 경우(409). 상태 재조회로만 판정한다. */
export const SESSION_COMPLETED = "이미 종료한 운동이라 루틴을 바꿀 수 없어요.";

const BY_ACTION: Record<ErrorAction, Partial<Record<number, string>>> = {
  session: {
    404: SESSION_NOT_FOUND,
  },
  catalog: {
    500: "운동 목록을 지금은 불러올 수 없어요.",
    501: "운동 목록을 지금은 불러올 수 없어요.",
  },
  add: {
    400: "선택한 운동을 추가할 수 없어요. 다른 운동을 골라 주세요.",
    404: SESSION_NOT_FOUND,
    409: "이미 오늘 루틴에 있는 운동이에요.",
  },
  remove: {
    404: "이미 루틴에서 빠진 운동이에요.",
    409: "기록이 남은 운동은 뺄 수 없어요. 완료 체크를 먼저 해제해 주세요.",
  },
  swap: {
    400: "선택한 운동으로 바꿀 수 없어요. 다른 운동을 골라 주세요.",
    404: "바꾸려는 운동이 루틴에 없어요. 목록을 새로 불러올게요.",
    409: "기록이 남은 운동은 바꿀 수 없어요. 완료 체크를 먼저 해제해 주세요.",
  },
  /*
    "기록은 저장했어요"라고 말하지 않는다 — STEP 5 의 세트 기록은 이 화면의 메모리에만 있고
    로컬 영속화·재전송(IndexedDB + outbox)은 STEP 6 이다. 화면을 벗어나면 사라지므로
    저장을 약속하면 거짓 안내가 된다. 대신 지금 화면에 남아 있다는 사실만 말한다.
  */
  complete: {
    400: "통증 점수는 0~10 중에서 골라 주세요.",
    404: "오늘 운동을 찾을 수 없어요. 대시보드에서 다시 시작해 주세요.",
    500: "지금은 기록하지 못했어요. 이 화면에 값이 남아 있으니 잠시 뒤 다시 눌러 주세요.",
  },
};

const BY_STATUS: Partial<Record<number, string>> = {
  400: "입력한 값을 다시 확인해 주세요.",
  404: "이 정보를 찾을 수 없어요.",
  409: "다른 곳에서 먼저 바뀐 것 같아요. 최신 상태로 다시 불러올게요.",
  500: SERVER,
  501: "이 기능은 아직 준비 중이에요.",
};

export function errorMessage(error: unknown, action: ErrorAction): string {
  // ApiError 가 아니면 네트워크 실패·타임아웃으로 본다(fetch 는 여기서 throw 한다).
  if (!(error instanceof ApiError)) return NETWORK;
  return BY_ACTION[action][error.status] ?? BY_STATUS[error.status] ?? SERVER;
}

/** 409 는 원인 구분이 불가능하므로(§3.2 주석) 최신 상태를 다시 받아온다. */
export function shouldRefetch(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 404);
}

/** 재조회한 세션 상태로 409 원인을 가려내기 위한 판별(문구 매칭 금지). */
export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

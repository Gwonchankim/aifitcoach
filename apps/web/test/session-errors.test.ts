/**
 * 에러 문구 매핑(UX_STATES §3). 서버 원문·에러코드가 사용자에게 새지 않는지 고정한다.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { errorMessage, shouldRefetch } from "../components/session/errors";

const FORBIDDEN = ["CONFLICT", "NOT_FOUND", "VALIDATION_ERROR", "INTERNAL_ERROR", "500", "409"];

describe("errorMessage", () => {
  it("삭제 409 는 기록이 있어 뺄 수 없다는 뜻으로 안내한다", () => {
    const message = errorMessage(new ApiError(409, "CONFLICT", "수행 기록이 있다: ps_1"), "remove");
    expect(message).toBe("기록이 남은 운동은 뺄 수 없어요. 완료 체크를 먼저 해제해 주세요.");
  });

  it("교체 409 도 같은 취지로 안내한다", () => {
    expect(errorMessage(new ApiError(409, "CONFLICT", "x"), "swap")).toContain("바꿀 수 없어요");
  });

  it("추가 409 는 중복 종목으로 안내한다", () => {
    expect(errorMessage(new ApiError(409, "CONFLICT", "x"), "add")).toBe(
      "이미 오늘 루틴에 있는 운동이에요.",
    );
  });

  it("세션 404 는 대시보드로 되돌린다", () => {
    expect(errorMessage(new ApiError(404, "NOT_FOUND", "세션을 찾을 수 없다."), "session")).toBe(
      "오늘 운동을 찾을 수 없어요. 대시보드에서 다시 시작해 주세요.",
    );
  });

  it("운동 종료 400 은 통증 점수 범위를 짚어 준다", () => {
    expect(errorMessage(new ApiError(400, "VALIDATION_ERROR", "pain"), "complete")).toBe(
      "통증 점수는 0~10 중에서 골라 주세요.",
    );
  });

  it("운동 종료 실패 문구는 저장을 약속하지 않는다(영속화는 STEP 6)", () => {
    // 세트 기록은 화면 메모리에만 있다 → "저장했어요"는 사실이 아니다.
    for (const status of [404, 500]) {
      const message = errorMessage(new ApiError(status, "INTERNAL_ERROR", "boom"), "complete");
      expect(message).not.toContain("저장");
    }
    expect(errorMessage(new ApiError(500, "INTERNAL_ERROR", "boom"), "complete")).toContain(
      "다시 눌러 주세요",
    );
  });

  it("카탈로그 501/500 은 같은 문구다", () => {
    expect(errorMessage(new ApiError(501, "NOT_IMPLEMENTED", "x"), "catalog")).toBe(
      "운동 목록을 지금은 불러올 수 없어요.",
    );
    expect(errorMessage(new ApiError(500, "INTERNAL_ERROR", "x"), "catalog")).toBe(
      "운동 목록을 지금은 불러올 수 없어요.",
    );
  });

  it("액션별 문구가 없으면 상태코드 기본 문구로 떨어진다", () => {
    expect(errorMessage(new ApiError(500, "INTERNAL_ERROR", "x"), "add")).toBe(
      "잠시 문제가 있었어요. 다시 시도해 주세요.",
    );
  });

  it("ApiError 가 아니면 네트워크 문구다", () => {
    expect(errorMessage(new TypeError("Failed to fetch"), "session")).toContain("인터넷 연결");
  });

  it("어떤 경우에도 서버 원문·에러코드를 노출하지 않는다", () => {
    const actions = ["session", "catalog", "add", "remove", "swap", "complete"] as const;
    const statuses = [400, 404, 409, 500, 501, 503];

    for (const action of actions) {
      for (const status of statuses) {
        const message = errorMessage(
          new ApiError(status, "CONFLICT", "운동을 찾을 수 없다: e_x"),
          action,
        );
        expect(message).not.toContain("e_x");
        for (const token of FORBIDDEN) expect(message).not.toContain(token);
      }
    }
  });
});

describe("shouldRefetch", () => {
  it("409·404 는 최신 상태를 다시 받아온다", () => {
    expect(shouldRefetch(new ApiError(409, "CONFLICT", "x"))).toBe(true);
    expect(shouldRefetch(new ApiError(404, "NOT_FOUND", "x"))).toBe(true);
    expect(shouldRefetch(new ApiError(500, "INTERNAL_ERROR", "x"))).toBe(false);
    expect(shouldRefetch(new TypeError("offline"))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import {
  CURRENT_PROGRAM_ERRORS,
  DASHBOARD_ERRORS,
  GENERATE_PROGRAM_ERRORS,
  OFFLINE_MESSAGE,
  isNotFound,
  toUiError,
} from "../lib/error-copy";

describe("에러 문구 매핑 (UX_STATES §3)", () => {
  it("서버 메시지와 코드를 화면 문구로 쓰지 않는다", () => {
    const result = toUiError(new ApiError(404, "NOT_FOUND", "운동을 찾을 수 없다: e_xxx"));

    expect(result.message).toBe("이 정보를 찾을 수 없어요.");
    expect(result.message).not.toContain("e_xxx");
    expect(result.message).not.toContain("NOT_FOUND");
    // code/status 는 로그·계측용으로만 남는다.
    expect(result.code).toBe("NOT_FOUND");
    expect(result.status).toBe(404);
  });

  it("상태코드별 기본 문구를 쓴다", () => {
    expect(toUiError(new ApiError(400, "VALIDATION_ERROR", "x")).message).toBe(
      "입력한 값을 다시 확인해 주세요.",
    );
    expect(toUiError(new ApiError(409, "CONFLICT", "x")).message).toContain("최신 상태로");
    expect(toUiError(new ApiError(500, "INTERNAL_ERROR", "x")).message).toBe(
      "잠시 문제가 있었어요. 다시 시도해 주세요.",
    );
    expect(toUiError(new ApiError(501, "NOT_IMPLEMENTED", "x")).message).toBe(
      "이 기능은 아직 준비 중이에요.",
    );
  });

  it("모르는 상태코드는 500 문구로 떨어진다", () => {
    expect(toUiError(new ApiError(418, "TEAPOT", "x")).message).toBe(
      "잠시 문제가 있었어요. 다시 시도해 주세요.",
    );
  });

  it("네트워크 실패는 오프라인 문구로 갈린다", () => {
    const result = toUiError(new TypeError("Failed to fetch"));

    expect(result.kind).toBe("offline");
    expect(result.message).toBe(OFFLINE_MESSAGE);
    expect(result.status).toBeNull();
  });

  it("액션별 문구가 기본 문구를 덮는다", () => {
    // E-3: UI 가 막지 못하는 유일한 generate 400.
    expect(
      toUiError(new ApiError(400, "VALIDATION_ERROR", "x"), GENERATE_PROGRAM_ERRORS).message,
    ).toBe("선택한 조건으로 계획을 만들 수 없어요. 이 단계에서 사용할 장비를 다시 확인해 주세요.");
    expect(
      toUiError(new ApiError(503, "SERVICE_UNAVAILABLE", "x"), GENERATE_PROGRAM_ERRORS).message,
    ).toBe("운동 계획에 필요한 데이터를 준비하지 못했어요. 잠시 후 다시 시도해 주세요.");
    // E-5
    expect(toUiError(new ApiError(404, "NOT_FOUND", "x"), CURRENT_PROGRAM_ERRORS).message).toBe(
      "아직 운동 계획이 없어요. 먼저 계획을 만들어 주세요.",
    );
    // E-22 (대시보드는 아직 501 이다)
    expect(toUiError(new ApiError(501, "NOT_IMPLEMENTED", "x"), DASHBOARD_ERRORS).message).toBe(
      "요약을 지금은 불러올 수 없어요.",
    );
  });

  it("404 는 빈 상태로 갈라내기 위해 따로 판별한다", () => {
    expect(isNotFound(new ApiError(404, "NOT_FOUND", "x"))).toBe(true);
    expect(isNotFound(new ApiError(500, "INTERNAL_ERROR", "x"))).toBe(false);
    expect(isNotFound(new TypeError("Failed to fetch"))).toBe(false);
  });
});

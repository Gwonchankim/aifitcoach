import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { FeatureConflictException } from "./feature-conflict";
import { SESSION_APPEND_REASONS, SessionAppendConflictException } from "./session-append-conflict";
import { WEEK_SWAP_REASONS, WeekSwapConflictException } from "./week-swap-conflict";

/**
 * 모든 예외를 openapi `Error` 스키마 `{ error: { code, message, details? } }` 로 직렬화하는 유일한 지점
 * (ADR-21, docs/CONVENTIONS.md 에러 엔벨로프).
 *
 * - HttpException: 상태코드를 그대로 쓰고, code 는 아래 표로, message 는 예외가 정한 문구로 낸다.
 * - 그 밖의 throw(코드 버그·드라이버 오류): 500 + 고정 문구. 원 메시지·스택은 서버 로그로만 남긴다
 *   (SECURITY_PIPA.md — 오류 응답에 내부 정보 미노출).
 * - details 는 409 중 타입이 정해진 conflict 예외의 허용된 `reason` 하나만 싣는다. 예외 객체에 붙은
 *   그 밖의 값(원 입력·내부 상태)은 응답으로 옮기지 않는다.
 */
const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  402: "PAYMENT_REQUIRED",
  404: "NOT_FOUND",
  409: "CONFLICT",
  501: "NOT_IMPLEMENTED",
  503: "SERVICE_UNAVAILABLE",
};

/** HttpException 이 아닌 예외에 쓰는 고정 문구. 내부 정보를 담지 않는다. */
const INTERNAL_MESSAGE = "서버 내부 오류가 발생했다.";

interface ErrorBody {
  code: string;
  message: string;
  details?: { reason: string };
}

function errorCode(status: number): string {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR");
}

/** ValidationPipe 는 message 를 문자열 배열로 준다 → 한 줄 메시지로 합친다. */
function errorMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === "string") return response;
  const { message } = response as { message?: unknown };
  if (Array.isArray(message)) return message.join(", ");
  if (typeof message === "string") return message;
  return exception.message;
}

/** 응답에 실어도 되는 409 reason. 타입이 정해진 conflict 예외의 허용 목록 값만 돌려준다. */
function conflictReason(exception: HttpException): string | undefined {
  if (exception.getStatus() !== 409) return undefined;
  if (exception instanceof FeatureConflictException) return exception.reason;
  if (
    exception instanceof SessionAppendConflictException &&
    SESSION_APPEND_REASONS.includes(exception.reason)
  ) {
    return exception.reason;
  }
  if (
    exception instanceof WeekSwapConflictException &&
    WEEK_SWAP_REASONS.includes(exception.reason)
  ) {
    return exception.reason;
  }
  return undefined;
}

function toEnvelope(exception: unknown): { status: number; error: ErrorBody } {
  if (!(exception instanceof HttpException)) {
    return { status: 500, error: { code: errorCode(500), message: INTERNAL_MESSAGE } };
  }
  const status = exception.getStatus();
  const reason = conflictReason(exception);
  return {
    status,
    error: {
      code: errorCode(status),
      message: errorMessage(exception),
      ...(reason === undefined ? {} : { details: { reason } }),
    },
  };
}

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException)) {
      this.logger.error("처리되지 않은 예외", exception);
    }
    const { status, error } = toEnvelope(exception);
    this.httpAdapterHost.httpAdapter.reply(host.switchToHttp().getResponse(), { error }, status);
  }
}

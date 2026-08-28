import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";

/**
 * 모든 예외를 openapi 의 Error 스키마(`{ error: { code, message } }`)로 직렬화한다.
 * docs/CONVENTIONS.md 의 에러 엔벨로프가 나오는 유일한 지점.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  402: "PAYMENT_REQUIRED",
  404: "NOT_FOUND",
  409: "CONFLICT",
  501: "NOT_IMPLEMENTED",
  503: "SERVICE_UNAVAILABLE",
};

/** HttpException 이 아닌 예외(코드 버그·드라이버 오류)에 쓰는 고정 문구. 내부 정보를 담지 않는다. */
const INTERNAL_MESSAGE = "서버 내부 오류가 발생했다.";

function errorCode(status: number): string {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR");
}

/** ValidationPipe 는 message 를 문자열 배열로 준다 → 한 줄 메시지로 합친다. */
function errorMessage(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === "string") return body;
  const { message } = body as { message?: unknown };
  if (Array.isArray(message)) return message.join(", ");
  if (typeof message === "string") return message;
  return exception.message;
}

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const http = exception instanceof HttpException ? exception : undefined;
    const status = http?.getStatus() ?? 500;
    // 내부 예외 메시지·스택은 응답이 아니라 서버 로그로만 남긴다(SECURITY_PIPA.md).
    if (!http) {
      this.logger.error("처리되지 않은 예외", exception);
    }

    httpAdapter.reply(
      host.switchToHttp().getResponse(),
      { error: { code: errorCode(status), message: http ? errorMessage(http) : INTERNAL_MESSAGE } },
      status,
    );
  }
}

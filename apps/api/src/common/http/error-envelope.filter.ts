import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";

/**
 * 모든 HttpException 을 openapi 의 Error 스키마(`{ error: { code, message } }`)로 직렬화한다.
 * docs/CONVENTIONS.md 의 에러 엔벨로프가 나오는 유일한 지점.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  402: "PAYMENT_REQUIRED",
  404: "NOT_FOUND",
  501: "NOT_IMPLEMENTED",
};

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

@Catch(HttpException)
export class ErrorEnvelopeFilter implements ExceptionFilter<HttpException> {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: HttpException, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const status = exception.getStatus();

    httpAdapter.reply(
      host.switchToHttp().getResponse(),
      { error: { code: errorCode(status), message: errorMessage(exception) } },
      status,
    );
  }
}

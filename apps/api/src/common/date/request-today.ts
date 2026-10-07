import {
  createParamDecorator,
  InternalServerErrorException,
  type ExecutionContext,
} from "@nestjs/common";
import { utcToday } from "./utc-day";

/**
 * BUG-10 (ADR-86) — the request's UTC day, the "판정 순간", captured once when the request arrives.
 *
 * It is captured in the FIRST middleware (configureApp), before anything can wait: session
 * authentication awaits a DB read, and a day captured after that wait is the day the wait ended —
 * crossing midnight there refused the previous day and accepted a future one (evaluator round 2).
 * Controllers read it (`@RequestToday()`) and pass it to services as an argument; services never
 * read the request, so they stay free of HTTP. Note: services taking `today` as a required argument
 * forces the value to be passed — it does not force where it was first captured. This file does.
 */
export type RequestWithToday = { requestToday?: Date };

export function captureRequestToday(
  request: RequestWithToday,
  _response: unknown,
  next: () => void,
): void {
  request.requestToday = utcToday();
  next();
}

/**
 * The day `captureRequestToday` wrote for this request. Missing means the middleware was not
 * registered — a setup error that fails loudly; it never falls back to "now" (a defaulted date is
 * the very defect this ticket fixes).
 */
export const RequestToday = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Date => {
    const today = context.switchToHttp().getRequest<RequestWithToday>().requestToday;
    if (!(today instanceof Date))
      throw new InternalServerErrorException(
        "요청의 판정 순간이 없다 — captureRequestToday 미들웨어가 등록되지 않았다.",
      );
    return today;
  },
);

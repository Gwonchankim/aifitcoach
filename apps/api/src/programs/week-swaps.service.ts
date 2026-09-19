import { createHash } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Program } from "@prisma/client";
import { weekStart } from "../analytics/aggregation.projector";
import { isoDate, utcToday } from "../common/date/utc-day";
import { WeekSwapConflictException } from "../common/http/week-swap-conflict";
import { PrismaService } from "../prisma/prisma.service";
import {
  lockProgramRows,
  lockSessionRows,
  retrySessionWrite,
} from "../sessions/session-write-transaction";
import { WeekSwapDto } from "./dto/week-swap.dto";
import { WEEKDAYS } from "./program-rules";
import { ProgramsService } from "./programs.service";
import {
  actualWeekSession,
  addDays,
  recoveryReason,
  recoveryTemplate,
  structuralReason,
  STRUCTURAL_REASONS,
  WEEK_SWAP_INCLUDE,
  type WeekSwapSession,
} from "./week-swap-projection";
import { weekSwapRevision } from "./week-swap-revision";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class WeekSwapsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly programs: ProgramsService,
  ) {}

  private async currentProgram(
    tx: Prisma.TransactionClient,
    userId: string,
    id: string,
  ): Promise<Program> {
    if (!UUID.test(id)) throw new NotFoundException("프로그램을 찾을 수 없다.");
    const program = await tx.program.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    if (!program || program.id !== id.toLowerCase())
      throw new NotFoundException("현재 프로그램을 찾을 수 없다.");
    return program;
  }

  private actual(tx: Prisma.TransactionClient, userId: string, start: Date, end: Date) {
    return tx.workoutSession.findMany({
      where: { program: { userId }, scheduledDate: { gte: start, lt: end } },
      orderBy: [{ scheduledDate: "asc" }, { id: "asc" }],
      include: WEEK_SWAP_INCLUDE,
    });
  }

  /** Warm reads avoid recomputing prescriptions. Missing template date slots retain original lazy semantics. */
  private async ensureWeek(
    tx: Prisma.TransactionClient,
    userId: string,
    program: Program,
    today: Date,
  ) {
    const start = weekStart(today),
      end = addDays(start, 7);
    let sessions = await tx.workoutSession.findMany({
      where: { programId: program.id, scheduledDate: { gte: start, lt: end } },
      orderBy: [{ scheduledDate: "asc" }, { id: "asc" }],
      include: WEEK_SWAP_INCLUDE,
    });
    const template = recoveryTemplate(program.template);
    const inLifecycle =
      start >= program.startedAt && start < addDays(program.startedAt, program.totalWeeks * 7);
    if (
      inLifecycle &&
      (!sessions.length ||
        template?.some((row) => {
          const date = addDays(start, WEEKDAYS.indexOf(row.day as (typeof WEEKDAYS)[number]));
          return !sessions.some((s) => +s.scheduledDate === +date);
        }))
    ) {
      if (!template) throw new BadRequestException("저장된 프로그램 구성을 확인할 수 없다.");
      const week = Math.floor((+start - +program.startedAt) / (7 * 86_400_000)) + 1;
      await this.programs.materializeWeekInTransaction(tx, userId, program, week);
      sessions = await tx.workoutSession.findMany({
        where: { programId: program.id, scheduledDate: { gte: start, lt: end } },
        orderBy: [{ scheduledDate: "asc" }, { id: "asc" }],
        include: WEEK_SWAP_INCLUDE,
      });
    }
    return sessions;
  }

  async current(userId: string, id: string) {
    id = id.toLowerCase();
    await this.currentProgram(this.prisma, userId, id);
    return this.prisma.$transaction(
      async (tx) => {
        await lockProgramRows(tx, [id]);
        const program = await this.currentProgram(tx, userId, id);
        const today = utcToday();
        const sessions = await this.ensureWeek(tx, userId, program, today);
        return {
          program_id: program.id,
          week_start: isoDate(weekStart(today)),
          sessions: sessions.map(actualWeekSession),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async candidates(userId: string, id: string) {
    id = id.toLowerCase();
    await this.currentProgram(this.prisma, userId, id);
    return this.prisma.$transaction(
      async (tx) => {
        await lockProgramRows(tx, [id]);
        const program = await this.currentProgram(tx, userId, id);
        const today = utcToday(),
          start = weekStart(today);
        const current = await this.ensureWeek(tx, userId, program, today);
        const actual = await this.actual(tx, userId, addDays(start, -7), addDays(start, 14));
        const todays = current.filter((s) => +s.scheduledDate === +today);
        if (!todays.length) throw new NotFoundException("오늘 운동을 찾을 수 없다.");
        const catalog = await tx.exercise.findMany();
        // Ambiguous today has no trustworthy identity, regardless of individual session status.
        const ambiguous = actual.filter((s) => +s.scheduledDate === +today).length > 1;
        const todaySession = todays[0];
        const todayReason = ambiguous
          ? ("ambiguous_schedule" as const)
          : structuralReason(todaySession, actual, today, id);
        const candidates = current
          .filter((s) => +s.scheduledDate !== +today)
          .map((session) => {
            const reason =
              structuralReason(session, actual, today, id) ??
              todayReason ??
              recoveryReason(program, actual, catalog, [todaySession.id, session.id], today);
            return {
              session: actualWeekSession(session),
              eligible: !reason && !todayReason,
              reason,
            };
          });
        return {
          program_id: program.id,
          week_start: isoDate(start),
          today_session_id: ambiguous ? null : todaySession.id,
          today_revision: ambiguous ? null : weekSwapRevision(todaySession),
          today_eligible: !todayReason,
          today_reason: todayReason,
          candidates,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async swap(userId: string, id: string, input: WeekSwapDto) {
    id = id.toLowerCase();
    const dto: WeekSwapDto = {
      client_id: input.client_id.toLowerCase(),
      today_session_id: input.today_session_id.toLowerCase(),
      target_session_id: input.target_session_id.toLowerCase(),
      today_revision: input.today_revision,
      target_revision: input.target_revision,
    };
    if (dto.today_session_id === dto.target_session_id)
      throw new BadRequestException("서로 다른 운동일을 선택해 주세요.");
    const requested = [dto.today_session_id, dto.target_session_id];
    if (!UUID.test(id)) throw new NotFoundException("프로그램을 찾을 수 없다.");
    const hash = createHash("sha256")
      .update(JSON.stringify({ program_id: id.toLowerCase(), ...dto }))
      .digest("hex");
    return retrySessionWrite(() =>
      this.prisma.$transaction(
        async (tx) => {
          const key = JSON.stringify(["week_swap", userId, dto.client_id]);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          // Read ownership after any advisory wait, before either replay or mismatch.
          await this.currentProgram(tx, userId, id);
          const owned = await tx.workoutSession.findMany({
            where: { id: { in: requested }, programId: id, program: { userId } },
            select: { id: true },
          });
          if (owned.length !== 2) throw new NotFoundException("운동일을 찾을 수 없다.");
          const receipt = await tx.weekSwapReceipt.findUnique({
            where: { userId_clientId: { userId, clientId: dto.client_id } },
          });
          if (receipt) {
            if (receipt.requestHash !== hash)
              throw new WeekSwapConflictException("idempotency_payload_mismatch");
            return receipt.result;
          }
          await lockProgramRows(tx, [id]);
          await lockSessionRows(tx, requested);
          const program = await this.currentProgram(tx, userId, id);
          const today = utcToday(),
            start = weekStart(today);
          // Post-lock reads observe the writer that held the same Program lock before us.
          const actual = await this.actual(tx, userId, addDays(start, -7), addDays(start, 14));
          let a = actual.find((s) => s.id === dto.today_session_id),
            b = actual.find((s) => s.id === dto.target_session_id);
          if (!a || !b) {
            const outside = await tx.workoutSession.findMany({
              where: { id: { in: requested }, programId: id, program: { userId } },
              include: WEEK_SWAP_INCLUDE,
            });
            a ??= outside.find((s) => s.id === dto.today_session_id);
            b ??= outside.find((s) => s.id === dto.target_session_id);
          }
          if (!a || !b || a.programId !== id || b.programId !== id)
            throw new NotFoundException("운동일을 찾을 수 없다.");
          const reasons = [
            structuralReason(a, actual, today, id),
            structuralReason(b, actual, today, id),
          ];
          const structural = STRUCTURAL_REASONS.find((reason) => reasons.includes(reason));
          if (structural) throw new WeekSwapConflictException(structural);
          if (
            +a.scheduledDate !== +today ||
            weekSwapRevision(a) !== dto.today_revision ||
            weekSwapRevision(b) !== dto.target_revision
          )
            throw new WeekSwapConflictException("stale_revision");
          const catalog = await tx.exercise.findMany();
          const recovery = recoveryReason(program, actual, catalog, [a.id, b.id], today);
          if (recovery) throw new WeekSwapConflictException(recovery);
          const aDate = a.scheduledDate,
            bDate = b.scheduledDate;
          await tx.workoutSession.update({ where: { id: a.id }, data: { scheduledDate: bDate } });
          await tx.workoutSession.update({ where: { id: b.id }, data: { scheduledDate: aDate } });
          const moved: WeekSwapSession[] = [
            { ...a, scheduledDate: bDate },
            { ...b, scheduledDate: aDate },
          ];
          const result = {
            client_id: dto.client_id,
            program_id: program.id,
            week_start: isoDate(start),
            today_session_id: b.id,
            sessions: moved
              .sort((x, y) => +x.scheduledDate - +y.scheduledDate || x.id.localeCompare(y.id))
              .map(actualWeekSession),
          };
          await tx.weekSwapReceipt.create({
            data: {
              userId,
              clientId: dto.client_id,
              requestHash: hash,
              request: { ...dto },
              result,
            },
          });
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      ),
    );
  }
}

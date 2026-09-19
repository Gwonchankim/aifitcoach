import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { notImplemented } from "../common/http/not-implemented";
import { GenerateProgramDto } from "./dto/generate-program.dto";
import { UpdateProgramDto } from "./dto/update-program.dto";
import { ProgramResponse, ProgramsService } from "./programs.service";
import { WeekSwapDto } from "./dto/week-swap.dto";
import { WeekSwapsService } from "./week-swaps.service";

@Controller("programs")
export class ProgramsController {
  constructor(
    private readonly programs: ProgramsService,
    private readonly weekSwaps: WeekSwapsService,
  ) {}

  @Get(":id/weeks/current")
  actualWeek(@CurrentUser() userId: string, @Param("id") programId: string) {
    return this.weekSwaps.current(userId, programId);
  }

  @Get(":id/week-swaps/candidates")
  swapCandidates(@CurrentUser() userId: string, @Param("id") programId: string) {
    return this.weekSwaps.candidates(userId, programId);
  }

  @Post(":id/week-swaps")
  @HttpCode(200)
  swapWeek(
    @CurrentUser() userId: string,
    @Param("id") programId: string,
    @Body() body: WeekSwapDto,
  ) {
    return this.weekSwaps.swap(userId, programId, body);
  }

  /** POST /programs/generate — 룰 기반 프로그램 생성 (Nest 기본 201 = openapi 계약) */
  @Post("generate")
  generate(
    @CurrentUser() userId: string,
    @Body() body: GenerateProgramDto,
  ): Promise<ProgramResponse> {
    return this.programs.generate(userId, body);
  }

  /** GET /programs/current — 현재 프로그램 조회 */
  @Get("current")
  current(@CurrentUser() userId: string): Promise<ProgramResponse> {
    return this.programs.current(userId);
  }

  /** PATCH /programs/{programId} — 프로그램 수정(세트수 등, 변경 사유 로깅) */
  @Patch(":programId")
  update(@Param("programId") _programId: string, @Body() _body: UpdateProgramDto): never {
    return notImplemented();
  }
}

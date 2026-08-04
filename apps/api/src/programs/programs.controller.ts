import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";
import { GenerateProgramDto } from "./dto/generate-program.dto";
import { UpdateProgramDto } from "./dto/update-program.dto";

@Controller("programs")
export class ProgramsController {
  /** POST /programs/generate — 룰 기반 프로그램 생성 */
  @Post("generate")
  generate(@Body() _body: GenerateProgramDto): never {
    return notImplemented();
  }

  /** GET /programs/current — 현재 프로그램 조회 */
  @Get("current")
  current(): never {
    return notImplemented();
  }

  /** PATCH /programs/{programId} — 프로그램 수정(세트수 등, 변경 사유 로깅) */
  @Patch(":programId")
  update(@Param("programId") _programId: string, @Body() _body: UpdateProgramDto): never {
    return notImplemented();
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  ParseArrayPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { notImplemented } from "../common/http/not-implemented";
import { CalibrationDto } from "./dto/calibration.dto";
import { ConsentDto } from "./dto/consent.dto";
import { ProfileUpdateDto } from "./dto/profile-update.dto";
import { ProfileResponse, UsersService } from "./users.service";

@Controller("me")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** GET /me — 내 프로필 조회 */
  @Get()
  getProfile(@CurrentUser() userId: string): Promise<ProfileResponse> {
    return this.users.getProfile(userId);
  }

  /** PATCH /me — 프로필 수정(목표 변경 시 프로그램 재구성 트리거) */
  @Patch()
  updateProfile(@Body() _body: ProfileUpdateDto): never {
    return notImplemented();
  }

  /** DELETE /me — 계정/데이터 삭제 요청(소프트 삭제 후 퍼지) */
  @Delete()
  @HttpCode(202)
  async deleteAccount(@CurrentUser() userId: string): Promise<void> {
    await this.users.requestDeletion(userId);
  }

  /**
   * POST /me/consents — 개인정보/약관 동의 기록(PIPA)
   * 최상위 JSON 배열 바디는 전역 ValidationPipe 가 건너뛴다(metatype === Array).
   * → ParseArrayPipe 로 배열 여부와 요소(ConsentDto)를 직접 검증한다.
   */
  @Post("consents")
  @HttpCode(204)
  async recordConsents(
    @CurrentUser() userId: string,
    @Body(new ParseArrayPipe({ items: ConsentDto, whitelist: true })) body: ConsentDto[],
  ): Promise<void> {
    await this.users.recordConsents(userId, body);
  }

  /** GET /me/export — 현재 보유한 사용자 데이터를 즉시 JSON으로 내보낸다. */
  @Get("export")
  exportData(@CurrentUser() userId: string): Promise<Record<string, unknown>> {
    return this.users.exportData(userId);
  }

  /** POST /me/calibration — 간이 캘리브레이션(시작 무게 추정) */
  @Post("calibration")
  calibrate(@Body() _body: CalibrationDto): never {
    return notImplemented();
  }
}

import { Body, Controller, Delete, Get, ParseArrayPipe, Patch, Post } from "@nestjs/common";
import { notImplemented } from "../common/http/not-implemented";
import { CalibrationDto } from "./dto/calibration.dto";
import { ConsentDto } from "./dto/consent.dto";
import { ProfileUpdateDto } from "./dto/profile-update.dto";

@Controller("me")
export class UsersController {
  /** GET /me — 내 프로필 조회 */
  @Get()
  getProfile(): never {
    return notImplemented();
  }

  /** PATCH /me — 프로필 수정(목표 변경 시 프로그램 재구성 트리거) */
  @Patch()
  updateProfile(@Body() _body: ProfileUpdateDto): never {
    return notImplemented();
  }

  /** DELETE /me — 계정/데이터 삭제 요청(소프트 삭제 후 퍼지) */
  @Delete()
  deleteAccount(): never {
    return notImplemented();
  }

  /**
   * POST /me/consents — 개인정보/약관 동의 기록(PIPA)
   * 최상위 JSON 배열 바디는 전역 ValidationPipe 가 건너뛴다(metatype === Array).
   * → ParseArrayPipe 로 배열 여부와 요소(ConsentDto)를 직접 검증한다.
   */
  @Post("consents")
  recordConsents(
    @Body(new ParseArrayPipe({ items: ConsentDto, whitelist: true })) _body: ConsentDto[],
  ): never {
    return notImplemented();
  }

  /** POST /me/export — 내 데이터 내보내기(비동기 생성) */
  @Post("export")
  requestExport(): never {
    return notImplemented();
  }

  /** POST /me/calibration — 간이 캘리브레이션(시작 무게 추정) */
  @Post("calibration")
  calibrate(@Body() _body: CalibrationDto): never {
    return notImplemented();
  }
}

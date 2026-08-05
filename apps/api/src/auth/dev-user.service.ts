import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { devUserId } from "./dev-user";

/**
 * dev-user 행 프로비저닝 — docs/TEST_SCOPE.md.
 * 로그인이 없어 온보딩(POST /me)이 없으므로 부팅 시 1회 upsert 한다.
 * (요청마다 upsert 하지 않는다: 요청 경로에 DB 왕복을 넣지 않기 위해.)
 * 프로필 값은 자리표시자다 — 프로그램 생성은 요청 바디의 goal/experience_level 을 쓴다.
 */
@Injectable()
export class DevUserService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.prisma.user.upsert({
      where: { id: devUserId() },
      update: {},
      create: {
        id: devUserId(),
        sex: "other",
        birthYear: 1995,
        heightCm: 175,
        weightKg: 75,
        goal: "hypertrophy",
        experienceLevel: "intermediate",
        constraints: {},
      },
    });
  }
}

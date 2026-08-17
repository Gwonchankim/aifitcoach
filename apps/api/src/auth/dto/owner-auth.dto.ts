import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { ConsentDto } from "../../users/dto/consent.dto";

const SEXES = ["male", "female", "other"] as const;
const GOALS = ["diet", "hypertrophy", "strength"] as const;
const EXPERIENCE_LEVELS = ["beginner", "intermediate", "advanced"] as const;

/** 최초 등록 때만 받는, 이미 User 모델에서 필요한 전체 프로필. */
export class OwnerProfileDto {
  @IsIn(SEXES)
  sex!: (typeof SEXES)[number];

  @IsInt()
  @Min(1900)
  @Max(new Date().getUTCFullYear())
  birth_year!: number;

  @IsNumber()
  @Min(100)
  @Max(250)
  height_cm!: number;

  @IsNumber()
  @Min(30)
  @Max(300)
  weight_kg!: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(70)
  body_fat_pct?: number | null;

  @IsIn(GOALS)
  goal!: (typeof GOALS)[number];

  @IsIn(EXPERIENCE_LEVELS)
  experience_level!: (typeof EXPERIENCE_LEVELS)[number];
}

export class OwnerLoginDto {
  /** 무차별 대입 비용을 높이는 길이 검증. 실제 비교는 timingSafeEqual로 한다. */
  @IsString()
  @Length(24, 256)
  owner_code!: string;
}

/** 공개 가입이 아닌, 최초 소유자 프로필+동의 원자 생성 요청. */
export class OwnerBootstrapDto extends OwnerLoginDto {
  @ValidateNested()
  @Type(() => OwnerProfileDto)
  profile!: OwnerProfileDto;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConsentDto)
  consents!: ConsentDto[];
}

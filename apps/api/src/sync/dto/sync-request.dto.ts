import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsUUID,
  ValidateNested,
} from "class-validator";

const ENTITIES = ["performed_set", "session", "profile"] as const;
const OPS = ["upsert", "delete"] as const;

/** openapi: Mutation */
export class MutationDto {
  @IsUUID()
  client_id!: string;

  @IsIn(ENTITIES)
  entity!: (typeof ENTITIES)[number];

  @IsIn(OPS)
  op!: (typeof OPS)[number];

  @IsObject()
  payload!: Record<string, unknown>;
}

/** openapi: SyncRequest */
export class SyncRequestDto {
  @IsOptional()
  @IsISO8601()
  since?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MutationDto)
  mutations!: MutationDto[];
}

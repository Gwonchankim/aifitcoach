import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from "class-validator";

const ENTITIES = ["performed_set", "session_routine", "session"] as const;
const OPS = ["upsert", "delete"] as const;

/** openapi: Mutation */
export class MutationDto {
  @IsUUID()
  client_id!: string;

  @IsIn(ENTITIES)
  entity!: (typeof ENTITIES)[number];

  @IsUUID()
  entity_id!: string;

  @IsIn(OPS)
  op!: (typeof OPS)[number];

  @IsISO8601()
  updated_at!: string;

  @IsObject()
  payload!: Record<string, unknown>;
}

/** openapi: SyncRequest */
export class SyncRequestDto {
  @IsOptional()
  @IsString()
  since?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MutationDto)
  mutations!: MutationDto[];
}

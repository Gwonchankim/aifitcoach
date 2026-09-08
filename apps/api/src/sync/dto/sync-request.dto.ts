import { BadRequestException } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  isUUID,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from "class-validator";
import { isAppendSetPayload } from "../../sessions/dto/append-set.dto";

const ENTITIES = ["performed_set", "session_routine", "session", "session_set"] as const;
const OPS = ["upsert", "delete"] as const;

export type AppendDependencies = {
  session_id: string;
  client_ids: string[];
  performed_client_ids?: string[];
};

function distinctIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => isUUID(id)) &&
    new Set(value.map((id: string) => id.toLowerCase())).size === value.length
  );
}

@ValidatorConstraint({ name: "appendDependencies", async: false })
class AppendDependenciesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const dependency = value as Record<string, unknown>;
    const mutation = args.object as MutationDto;
    const completion =
      mutation.entity === "session" &&
      mutation.op === "upsert" &&
      mutation.payload?.status === "completed";
    if (mutation.entity !== "performed_set" && !completion) return false;
    const keys = ["session_id", "client_ids", ...(completion ? ["performed_client_ids"] : [])];
    return (
      Object.keys(dependency).every((key) => keys.includes(key)) &&
      isUUID(dependency.session_id) &&
      distinctIds(dependency.client_ids) &&
      (!Object.hasOwn(dependency, "performed_client_ids") ||
        distinctIds(dependency.performed_client_ids))
    );
  }

  defaultMessage(): string {
    return "append_dependencies requires scoped distinct UUIDs; performed_client_ids is completion-only";
  }
}

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
  @Transform(({ obj, value }: { obj: Record<string, unknown>; value: unknown }) => {
    if (obj.entity === "session_set" || obj.append_dependencies !== undefined) {
      const keys = ["client_id", "entity", "entity_id", "op", "updated_at", "payload"];
      if (obj.entity !== "session_set") keys.push("append_dependencies");
      if (Object.keys(obj).some((key) => !keys.includes(key))) {
        throw new BadRequestException("Unsupported append mutation fields");
      }
    }
    if (obj.entity === "session_set" && (obj.op !== "upsert" || !isAppendSetPayload(value))) {
      throw new BadRequestException("Invalid session_set upsert payload");
    }
    return value;
  })
  payload!: Record<string, unknown>;

  @Validate(AppendDependenciesConstraint)
  append_dependencies?: AppendDependencies;
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

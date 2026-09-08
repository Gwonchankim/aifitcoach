import { BadRequestException } from "@nestjs/common";
import { Transform } from "class-transformer";
import {
  IsNotEmpty,
  IsString,
  IsUUID,
  isUUID,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";

export type AppendSource =
  { source_planned_set_id: string; source_revision: string } | { source_correlation_id: string };

export type AppendSetPayload = {
  exercise_id: string;
  correlation_id: string;
  source: AppendSource;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isAppendSource(value: unknown): value is AppendSource {
  if (!record(value)) return false;
  if (exactKeys(value, ["source_correlation_id"])) return isUUID(value.source_correlation_id);
  return (
    exactKeys(value, ["source_planned_set_id", "source_revision"]) &&
    isUUID(value.source_planned_set_id) &&
    typeof value.source_revision === "string" &&
    value.source_revision.length > 0
  );
}

export function isAppendSetPayload(value: unknown): value is AppendSetPayload {
  return (
    record(value) &&
    exactKeys(value, ["exercise_id", "correlation_id", "source"]) &&
    typeof value.exercise_id === "string" &&
    value.exercise_id.length > 0 &&
    isUUID(value.correlation_id) &&
    isAppendSource(value.source)
  );
}

@ValidatorConstraint({ name: "appendSource", async: false })
class AppendSourceConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isAppendSource(value);
  }

  defaultMessage(): string {
    return "source must contain exactly a server ID/revision or a source correlation ID";
  }
}

/** OpenAPI AppendSetRequest. Inspect the original body before the common whitelist strips keys. */
export class AppendSetDto {
  @IsUUID()
  client_id!: string;

  @IsString()
  @IsNotEmpty()
  exercise_id!: string;

  @IsUUID()
  correlation_id!: string;

  @Transform(({ obj, value }: { obj: unknown; value: unknown }) => {
    if (!record(obj) || !exactKeys(obj, ["client_id", "exercise_id", "correlation_id", "source"])) {
      throw new BadRequestException("Unsupported append request fields");
    }
    return value;
  })
  @Validate(AppendSourceConstraint)
  source!: AppendSource;
}

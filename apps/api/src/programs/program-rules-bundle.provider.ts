import { Injectable } from "@nestjs/common";
import { ROUTINE_RULES_VERSION } from "shared";

/** Only a Nest TestingModule override may select a reserved bundle before activation. */
@Injectable()
export class ProgramRulesBundleProvider {
  current(): string {
    return ROUTINE_RULES_VERSION;
  }
}

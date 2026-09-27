import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { RULES_BUNDLE_V2_SPLIT } from "shared";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/app.setup";
import { ProgramRulesBundleProvider } from "../../src/programs/program-rules-bundle.provider";

/** Test-only HTTP bootstrap. Auth, CSRF, controller, generator and storage remain real. */
async function bootstrap() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ProgramRulesBundleProvider)
    .useValue({ current: () => RULES_BUNDLE_V2_SPLIT })
    .compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.listen(process.env.PORT ?? 3341);
}
void bootstrap();

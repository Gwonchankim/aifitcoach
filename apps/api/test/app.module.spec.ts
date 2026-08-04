import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";

describe("AppModule", () => {
  it("컴파일된다", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});

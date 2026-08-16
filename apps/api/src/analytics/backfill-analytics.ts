import path from "node:path";
import dotenv from "dotenv";
import { PrismaService } from "../prisma/prisma.service";
import { AggregationProjector } from "./aggregation.projector";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

async function main(): Promise<void> {
  // tsx/esbuild does not emit Nest's decorator metadata. Instantiate the two concrete services
  // directly so this operational backfill cannot silently receive an undefined Prisma dependency.
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const rebuilt = await new AggregationProjector(prisma).rebuildAll();
    process.stdout.write(`analytics backfill complete: ${rebuilt} user(s)\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

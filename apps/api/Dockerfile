# syntax=docker/dockerfile:1
# Build context is the repository root: docker build -f apps/api/Dockerfile .
# The migrate target intentionally retains Prisma CLI; the runtime target contains only production deps.
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# Root postinstall builds shared, so its build inputs must exist before pnpm install.
COPY packages/shared/tsconfig.json packages/shared/tsconfig.build.json packages/shared/
COPY packages/shared/src packages/shared/src
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY apps/api apps/api
COPY scripts scripts
RUN pnpm --filter shared build \
  && pnpm --filter api exec prisma generate --schema prisma/schema.prisma \
  && pnpm --filter api build

# Cloud Run Job image: use DIRECT_URL through scripts/prisma-migrate.mjs. Never run this at API startup.
FROM build AS migrate
CMD ["node", "scripts/prisma-migrate.mjs"]

# Cloud Run seed Job image. The seed file is deliberately absent from the API runtime image;
# only the explicit one-shot seed target carries the catalog source of truth.
FROM build AS seed
COPY docs/specs/exercises_seed.json docs/specs/exercises_seed.json
CMD ["pnpm", "--filter", "api", "db:seed"]

FROM build AS production-deps
# `pnpm deploy` reruns postinstall without the API schema source context and leaves Prisma's default stub.
# Copy the schema-generated client into the runtime package's own resolution path.
RUN pnpm --filter api --prod deploy /opt/api \
  && source_client="$(find /app/node_modules/.pnpm -path '*/node_modules/@prisma/client' -type d -print -quit)" \
  && runtime_client="$(find /opt/api/node_modules/.pnpm -path '*/node_modules/@prisma/client' -type d -print -quit)" \
  && test -n "$source_client" \
  && test -n "$runtime_client" \
  && source_modules="$(dirname "$(dirname "$source_client")")" \
  && runtime_modules="$(dirname "$(dirname "$runtime_client")")" \
  && cp -a "$source_modules/.prisma/client/." "$runtime_modules/.prisma/client/"

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=production-deps /opt/api ./
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]

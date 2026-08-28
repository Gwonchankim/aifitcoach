# 비공개 스테이징 배포 — M-AUTH+DEPLOY

> 상태: **비공개 스테이징 배포·검증 중**. 실제 시크릿 값은 이 문서와 저장소에 기록하지 않는다.

구성은 Vercel(웹) → same-origin `/api/v1/*` rewrite → Cloud Run(API) → Neon(PostgreSQL)이다. Redis는 코드에서 사용하지 않으므로 이 구성에 넣지 않는다.

## 운영 경계

- Cloud Run API는 Vercel rewrite가 호출할 수 있도록 공개 도달 가능해야 한다. 공개 URL은 곧 공개 데이터가 아니다. 모든 데이터 API는 서버 세션을 요구하고 production에서는 `AUTH_MODE=dev-user`가 부팅 단계에서 거부된다.
- 브라우저 쿠키는 Vercel 웹 호스트에만 발급된다: `sid; HttpOnly; Secure; SameSite=Lax; Path=/`와 읽기 가능한 이중 제출 `csrf; Secure; SameSite=Lax; Path=/`다. JS는 `csrf`만 `X-CSRF-Token`으로 보내며 `sid`에는 접근하지 못한다. Vercel이 `/api/v1` 요청과 쿠키를 Cloud Run에 전달하므로 cross-site cookie/CORS 경로가 없다(ADR-67).
- API의 `WEB_ORIGIN`은 여전히 명시 허용목록이다. 운영 rewrite에는 CORS가 필요 없지만, 직접 API 브라우저 검증과 로컬 `00-api-cors` 회귀를 보호한다.
- 소유자 복구 코드는 최초 등록과 기기 변경 뒤 로그인에 모두 쓰인다. Secret Manager에만 저장하고, DB·응답·로그에는 원문을 남기지 않는다. 코드를 아는 사람은 계정에 접근할 수 있다.

## Neon

1. 서울과 가까운 리전에 빈 Neon 프로젝트/데이터베이스를 만든다. 기존 dev-user 데이터는 옮기지 않는다.
2. **pooled** 연결 문자열을 `DATABASE_URL` 시크릿으로 만든다. Cloud Run 런타임 Prisma는 이것만 사용한다.
3. **direct (non-pooled)** 연결 문자열을 `DIRECT_URL` 시크릿으로 따로 만든다. `scripts/prisma-migrate.mjs`가 Cloud Run Job에서만 이를 `DATABASE_URL`로 교체해 `prisma migrate deploy`를 실행한다.

필요 시크릿은 네 개다.

| 시크릿 | 주입 대상 | 설명 |
|---|---|---|
| `DATABASE_URL` | API 서비스 | Neon pooled connection string |
| `DIRECT_URL` | migrate Job | Neon direct connection string |
| `FIELD_ENCRYPTION_KEY` | API 서비스 | `openssl rand -base64 32`으로 만든 AES-256-GCM 키 |
| `OWNER_RECOVERY_CODE` | API 서비스 | 32바이트 이상 무작위 값. 비밀번호 관리자에 별도 보관 |

`DIRECT_URL`은 API 서비스에 주입하지 않는다. `OWNER_RECOVERY_CODE`도 migrate Job에는 필요 없다.

## 이미지·마이그레이션·시드·Cloud Run

`cloudbuild.staging.yaml`은 runtime·migrate·seed target을 각각 만든다. API 시작 시 마이그레이션이나 시드를 실행하지 않는다. 인스턴스가 동시에 시작할 때 같은 DDL/시드를 실행하지 않도록 **마이그레이션 → 시드 → 검증 → API 배포**를 명시적 Cloud Run Job 순서로 수행한다.

```powershell
gcloud builds submit --config cloudbuild.staging.yaml `
  --substitutions=_RUNTIME_IMAGE=asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api:<TAG>,_MIGRATE_IMAGE=asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api-migrate:<TAG>,_SEED_IMAGE=asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api-seed:<TAG>

# 이미 생성된 Job은 image만 갱신한다. service account·secret 주입·재시도 정책을 다시 선언해
# 실수로 기존 보안 설정을 덮어쓰지 않는다.
gcloud run jobs update afc-staging-migrate --image asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api-migrate:<TAG> `
  --region asia-southeast1
gcloud run jobs execute afc-staging-migrate --region asia-southeast1 --wait

gcloud run jobs update afc-staging-seed --image asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api-seed:<TAG> `
  --region asia-southeast1
gcloud run jobs execute afc-staging-seed --region asia-southeast1 --wait
# 멱등성 live 검증: 한 번 더 실행해도 두 로그 모두 "seeded 105 exercises (table count = 105)"여야 한다.
gcloud run jobs execute afc-staging-seed --region asia-southeast1 --wait

# 이미 생성된 API 서비스도 image만 갱신한다. 공개 접근·scale 설정·origin·시크릿 주입을
# 배포 명령에서 재선언해 기존 보안 설정을 실수로 덮어쓰지 않는다.
gcloud run services update afc-staging-api --image asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api:<TAG> `
  --region asia-southeast1
```

마이그레이션 또는 시드 Job이 실패하면 API 이미지를 배포하지 않는다. `82863e3` 기준 마이그레이션은 13개이며, 이후에는 숫자를 하드코딩하지 않고 `prisma migrate status`의 pending 0과 아래 drift 0을 판정한다.

```powershell
# DB migration ↔ Prisma datamodel drift 0. 차이가 있으면 exit 2라 배포를 중단한다.
gcloud run jobs update afc-staging-schema-verify `
  --image asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api-seed:<TAG> `
  --region asia-southeast1 `
  --command pnpm --args=--filter,api,exec,prisma,migrate,diff,--from-schema-datasource=prisma/schema.prisma,--to-schema-datamodel=prisma/schema.prisma,--exit-code
gcloud run jobs execute afc-staging-schema-verify --region asia-southeast1 --wait

# API 배포 뒤 카탈로그 smoke. 목록은 페이지네이션 전부를 합쳐 count/고유 ID/대체 참조를 확인한다.
$base = "https://<VERCEL-PRODUCTION-HOST>/api/v1"
$all = @(); $cursor = $null
do {
  $uri = if ($cursor) { "$base/exercises?cursor=$([uri]::EscapeDataString($cursor))" } else { "$base/exercises" }
  $page = Invoke-RestMethod $uri
  $all += $page.items
  $cursor = $page.next_cursor
} while ($cursor)
if ($all.Count -ne 105 -or (@($all.id | Sort-Object -Unique)).Count -ne 105) { throw "exercise count/unique mismatch" }
$ids = @{}; $all.id | ForEach-Object { $ids[$_] = $true }
$dangling = @($all | ForEach-Object { $_.substitutions } | Where-Object { -not $ids.ContainsKey($_) })
if ($dangling.Count -ne 0) { throw "dangling substitutions: $($dangling -join ',')" }
(Invoke-WebRequest "$base/exercises/e_pushup").StatusCode # 200
```

빈 카탈로그를 사용자 입력 오류로 위장하지 않도록 API는 생성 시 503을 반환한다. Cloud Run의 각 scale-to-zero 기동마다 DB count를 readiness에 넣으면 일시적인 Neon 장애가 새 인스턴스 전체를 불능으로 만들고 콜드 스타트에 DB 왕복을 추가한다. 이 참조 데이터는 배포 때만 바뀌므로 **시드·검증 Job을 release hard gate로 두는 방식을 우선 채택**한다. 시작 경고만 남기는 방식은 트래픽을 막지 못해 부적절하다. 별도 startup probe를 추가하려면 Cloud Run revision 설정까지 한 티켓으로 묶어 실제 cold-start/장애 동작을 검증한다.

계정 삭제의 물리 퍼지는 같은 migration 이미지를 쓰되 별도 Job으로만 실행한다. `PURGE_BEFORE`는 운영자가 그 실행의 보존 기준으로 정한 UTC 시각이며, 누락하면 Job은 실패한다.

```powershell
gcloud run jobs deploy afc-staging-purge --image asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api-migrate:<TAG> `
  --region asia-southeast1 --command node --args scripts/purge-deleted-users.mjs `
  --set-secrets DIRECT_URL=afc-direct-url:latest `
  --set-env-vars PURGE_BEFORE=2026-09-01T00:00:00.000Z
gcloud run jobs execute afc-staging-purge --region asia-southeast1 --wait
```

실행 전 해당 cutoff와 보존 사유를 운영 기록에 남긴다. `auth_attempts`는 사용자 식별자와 연결되지 않은 대입 방어 버킷이므로 이 Job의 대상이 아니다.

`min=0`, `max=1`, `concurrency=20`은 단일 사용자의 Neon 연결 수와 무료 티어 초과 위험을 제한한다. Cloud Run 예산 알림과 Artifact Registry/네트워크 비용 알림을 프로젝트 청구 계정에서 별도로 설정한다. 스케일 투 제로의 첫 요청은 콜드 스타트가 날 수 있으므로, 배포 후 `GET /v1/me` 인증 요청의 브라우저 대기 시간을 기록한다.

## Vercel

Vercel 프로젝트의 Root Directory는 **`apps/web`**이며, **Include files outside the root directory**를 켠다. install/build 명령에서 레포 루트로 이동해 workspace `shared`를 함께 설치·빌드한다.

| Vercel 설정 | 값 |
|---|---|
| Install Command | `cd ../.. && pnpm install --frozen-lockfile` |
| Build Command | `cd ../.. && pnpm --filter web build` |
| Production/Preview `NEXT_PUBLIC_API_BASE_URL` | `/api/v1` |
| Production/Preview `API_PROXY_ORIGIN` | `https://<CLOUD-RUN-SERVICE>.run.app` |

`API_PROXY_ORIGIN`은 Next 서버 전용 환경 변수이며 브라우저 번들에는 넣지 않는다. `apps/web/next.config.mjs`가 이 origin으로 `/api/v1/:path*`를 rewrite한다. Vercel preview도 같은 staging API로 연결할 수 있으므로, URL을 제3자에게 공유하지 말고 소유자 코드도 입력하지 않는다. Hobby 플랜에서 production deployment protection은 사용할 수 없으므로 애플리케이션 인증이 필수다.

Serwist는 production build에서만 활성화되며, 92개 Pretendard subset은 `apps/web/public/fonts` 정적 자산으로 함께 배포된다. `/api/v1/**`는 service worker cache 대상이 아니다.

## 배포 확인 순서

1. Vercel production URL의 `/auth/bootstrap`에서 소유자 코드·프로필·동의를 등록한다.
2. 브라우저 개발자 도구에서 `sid`가 HttpOnly·Secure·SameSite=Lax이고 Vercel 호스트 쿠키인지 확인한다. `localStorage`/`sessionStorage`에 토큰이 없어야 한다.
3. 최초 설정 → 프로그램 생성 → 세트 기록 → 온라인 동기화 → 새 브라우저 프로필에서 `/auth` 재로그인을 확인한다.
4. `내 정보`에서 JSON 내보내기가 평문 체지방/통증을 포함하고 `v1:` 암호문을 노출하지 않는지 확인한다.
5. 테스트 계정 삭제 후 이전 `sid`가 모든 API에서 401인지 확인한다. 필요한 보존기간이 지난 테스트 계정에 대해서만 purge Job을 실행하고, 계정·세션·동의·감사·운동 행이 모두 사라졌는지 확인한다.

## 배포 전 금지 사항

- `ALLOW_DEV_USER_AUTH` 또는 `AUTH_MODE=dev-user`를 Cloud Run에 넣지 않는다.
- 실행 중 API 컨테이너의 시작 명령에 `prisma migrate deploy`를 넣지 않는다.
- Neon direct URL을 runtime `DATABASE_URL`에 넣지 않는다.
- `WEB_ORIGIN=*`, `SameSite=None`, 브라우저 직접 Cloud Run URL 호출을 추가하지 않는다.
- 시크릿·Neon URL·소유자 코드를 Vercel public 변수, 소스, 로그, 이슈에 넣지 않는다.

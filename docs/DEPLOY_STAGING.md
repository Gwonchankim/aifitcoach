# 비공개 스테이징 배포 — M-AUTH+DEPLOY

> 상태: **배포 산출물 준비 중**. 이 문서는 사용자 계정·도메인·시크릿을 만들거나 외부 서비스에 배포하지 않는다.

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

## 이미지·마이그레이션·Cloud Run

`cloudbuild.staging.yaml`은 runtime과 migrate target을 각각 만든다. API 시작 시 마이그레이션을 실행하지 않는다. 인스턴스가 동시에 시작할 때 같은 DDL을 실행하는 위험을 피하기 위해 Cloud Run Job을 먼저 한 번 실행한다.

```powershell
gcloud builds submit --config cloudbuild.staging.yaml `
  --substitutions=_RUNTIME_IMAGE=asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api:<TAG>,_MIGRATE_IMAGE=asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api-migrate:<TAG>

gcloud run jobs deploy afc-staging-migrate --image asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api-migrate:<TAG> `
  --region asia-southeast1 --set-secrets DIRECT_URL=afc-direct-url:latest
gcloud run jobs execute afc-staging-migrate --region asia-southeast1 --wait

gcloud run deploy afc-staging-api --image asia-southeast1-docker.pkg.dev/<PROJECT>/afc/api:<TAG> `
  --region asia-southeast1 --allow-unauthenticated --port 8080 `
  --min-instances 0 --max-instances 1 --concurrency 20 --cpu 1 --memory 512Mi `
  --set-env-vars NODE_ENV=production,AUTH_MODE=session,WEB_ORIGIN=https://<VERCEL-PRODUCTION-HOST> `
  --set-secrets DATABASE_URL=afc-pooled-url:latest,FIELD_ENCRYPTION_KEY=afc-field-key:latest,OWNER_RECOVERY_CODE=afc-owner-code:latest
```

마이그레이션 Job이 실패하면 API 이미지를 배포하지 않는다. 새 마이그레이션마다 같은 순서로 Job을 실행한다.

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

Vercel 프로젝트의 Root Directory는 **레포 루트**로 둔다. 그래야 workspace `shared`를 함께 설치·빌드할 수 있다.

| Vercel 설정 | 값 |
|---|---|
| Install Command | `pnpm install --frozen-lockfile` |
| Build Command | `pnpm --filter web build` |
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

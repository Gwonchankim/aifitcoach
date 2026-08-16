# 테스트 단계 스코프 (AFC)

> 개발자 본인이 직접 써보며 기능을 다듬는 단계의 범위. **로그인·결제·법무는 이 단계에서 보류**하고,
> 실제 사용자 공개/과금 전에 도입한다.
> 원칙: "제거"가 아니라 **나중에 끼울 자리를 비워둔다**. 데이터·API·추천 구조는 그대로 두고, 인증 주체만 나중에 교체.

## 이 단계에서 보류(구현하지 않음)
- 소셜 로그인·세션 쿠키·CSRF·로그인/회원가입 화면.
- 결제(PG)·구독 실연동, 청구/환불/웹훅.
- 법무 3종(개인정보처리방침·이용약관·정기결제/환불), 통신판매업 신고, 개인정보 동의 UI.

## 대체 방식
- **고정 개발용 단일 사용자(dev-user)**: 서버가 모든 요청을 고정 user_id(env `DEV_USER_ID`, 기본 `"dev-user"`)로 처리한다.
  인증 미들웨어/가드 자리에 "고정 사용자 주입" 미들웨어를 둔다.
- **엔타이틀먼트 토글**: Pro 기능은 결제 대신 코드/DB 플래그(free/pro)로 전환(STEP 7).

## 반드시 유지(나중을 위한 준비)
- 모든 데이터는 **user_id에 매달아 저장**한다(dev-user라도). 나중에 로그인 붙일 때 그대로 재사용.
- 인증 지점을 **한 곳(미들웨어/가드)** 으로 격리 → 나중에 소셜 OAuth + 쿠키 세션 + CSRF 어댑터로 **그 지점만 교체**.
- 시크릿 미커밋(.env). 건강 민감데이터(pain 등) 과도 로깅 금지(최소 위생).

## STEP 영향
- **STEP 4**: auth(로그인/쿠키/CSRF)·me/consents/export/delete **건너뜀**. 대신 고정 dev-user 미들웨어 + programs/sessions(+세션 편집)만 구현.
- **STEP 7**: 결제 실연동 대신 엔타이틀먼트 토글 + 핵심 이벤트 계측.
- **STEP 8 / 법무**: 개발자 본인 테스트·피드백·추가 기능 완료 후 도입.
- **테스트 우선 목표 범위**: **STEP 6까지**(핵심 루프: 온보딩→프로그램→오프라인 로깅→추천→동기화).

## STEP 6 데이터 무결성 보장 경계

- IndexedDB transaction이 성공하고 브라우저 저장소가 유지되는 한 reload·탭/앱 종료·재오프라인·응답 유실·다중 탭에서도 기록 유실 0·중복 0을 자동 테스트로 증명한다.
- 명시적 사이트 데이터 삭제, OS의 저장소 강제 축출, 디스크 고장은 보장 범위 밖이다. 대신 persistent storage를 요청하고 로컬 commit 실패 시 성공 상태를 표시하지 않는다.
- LWW가 의도적으로 선택하지 않은 값은 transport 유실과 구분한다. 패자 mutation은 서버 audit와 로컬 conflict 상태에 남긴다.
- sync E2E는 직렬 실행한다. Chromium은 offline reload·응답 유실·재오프라인·다중 탭 LWW·pull의 전체 fault matrix를 소유한다. WebKit도 실제 context offline 상태에서 add/swap/즉시 기록을 수행하되, Playwright WebKit이 offline navigation을 service worker로 넘기지 않는 도구 한계 때문에 worker를 해제하고 페이지가 없는 동안 문서 transport만 복구한 뒤 API를 차단해 새 탭 IndexedDB 복구를 검증한다. 실제 iOS HTTPS PWA 종료/재실행 walkthrough는 별도 게이트다.
- 오프라인 routine add→swap→서버 mapping 전 즉시 세트 기록은 provisional ID가 서버에 저장되지 않고 authoritative ID로만 정확히 1회 반영되는지 확인한다. mapping 응답 유실 재전송은 같은 planned set을 반환해야 하며, client mapping transaction 중단은 draft·outbox·mirror 모두 임시 ID로 롤백돼야 한다.
- pull E2E는 다른 클라이언트가 만든 performed-set upsert가 로컬 draft가 없는 탭에도 생성되고, 더 최신 delete tombstone이 완료 상태를 해제하는 데까지 관찰한다. 서버 계약의 `changes` 배열만 확인하고 브라우저 mirror 반영을 생략하면 통과로 세지 않는다.

## M-4′ 집계 정확성 게이트

- 같은 사실 행을 다른 순서로 삽입해도 정렬된 API JSON이 바이트 단위로 같아야 한다.
- 세션/주 단위 증분 projection과 전체 rebuild의 DB 행·API 응답이 같아야 한다.
- 완료·sync·backfill 재실행은 중복 e1RM/PR/hard-set을 만들지 않는다.
- raw Epley PR을 저반복 우선+RIR 보정 공용 공식으로 바꿀 때 기존 projection을 전량 rebuild한다.
  M-4′의 캘리브레이션 bias는 미구현 상태를 숨기지 않고 0을 명시적으로 사용한다.
- 3세션 게이트는 세트 수가 아니라 종목별 distinct 완료 세션 수를 센다. 서버가 값/추천을 제거한 결과가 온라인 권위다.
- 데이터가 있는 DB에서 lifecycle/aggregate migration과 backfill을 검증한다. 레거시 generation input은 추측하지 않고 template snapshot fallback을 쓴다.

## 나중에 로그인 도입 시 (체크리스트)
- dev-user 주입 미들웨어를 소셜 OAuth + httpOnly 세션 쿠키 + CSRF로 교체(docs/SECURITY_PIPA.md).
- me/consents/export/delete 엔드포인트 구현, 온보딩에 동의 UI 추가.
- 기존 dev-user 데이터 마이그레이션(선택) 또는 신규 계정부터 적용.

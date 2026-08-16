# 실기기 워크스루 (iOS / Android) — HTTPS 셋업 + 확인 순서

목적: **실기기에서만 드러나는 결함**을 잡는다. `localhost` 는 스펙상 항상 secure context 라
`crypto.randomUUID`·서비스워커가 잘 돌지만 실기기(`http://사설IP`)에서는 없다 — 이걸로 세트 완료가
전부 실패했는데 E2E 37개가 전부 통과한 적이 있다(CLAUDE.md 함정 1). 그래서 **폰은 HTTPS 로 붙인다.**
터널(ngrok 등)은 쓰지 않는다 — ADR-43.

아래 절차는 이 PC 에서 **실제로 실행해 검증**했다. 2026-08-16 production-LAN 기준으로 인증서
`Verification: OK`, 페이지·프록시 API·`/sw.js` 200, Service Worker `activated`+controller 확보,
`afc-pages-v1`·`afc-fonts-v1` 동시 생성, Chromium 오프라인 reload까지 통과했다.

---

## 0. 사전 확인 — 폰과 PC 가 같은 Wi-Fi 인가

폰과 PC 가 **같은 네트워크**에 있어야 한다. 게스트 Wi-Fi·AP 격리(클라이언트 간 통신 차단)면 안 된다.

PC 의 LAN IP 확인 — **`ipconfig` 만 보면 안 된다.** 끊긴 어댑터에 주소가 그대로 남아 있어서,
안 닿는 IP 를 "현재 IP" 로 착각한다(실측: Wi-Fi 가 Disconnected 인데 `192.168.0.143` 이 계속 보였다).
**어댑터 상태를 같이 본다:**

```powershell
Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name, InterfaceIndex
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } |
  Select-Object InterfaceAlias, IPAddress
```

**`Status = Up` 인 어댑터의 IP 만 쓴다.** `vEthernet (WSL …)`·`vEthernet (Default Switch)` 의
`172.x` 는 가상 스위치라 폰에서 안 닿는다 — 고르지 마라.

이 PC 기준 (2026-08-08 실측):

| 어댑터 | IP | 상태 |
| --- | --- | --- |
| 이더넷 | `192.168.0.174` | **Up — 현재 이 주소를 쓴다** |
| Wi-Fi | `192.168.0.143` | Disconnected (주소만 잔존, 안 닿음) |

> PC 가 유선이어도 상관없다. 폰이 **같은 공유기의 Wi-Fi** 에 붙어 있고 같은 대역(`192.168.0.x`)이면 통한다.

> **IP 가 바뀌면 인증서를 다시 만들어야 한다**(SAN 에 IP 가 박혀 있다) → [§2.1 IP 변경 시 재발급](#21-ip-가-바뀌었을-때-재발급)

방화벽에서 3000 포트를 열어둔다(최초 1회, 관리자 PowerShell):

```powershell
New-NetFirewallRule -DisplayName "AFC dev 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

---

## 1. 왜 그냥 `--experimental-https` 만으로는 안 되는가 (실측한 함정 3개)

| # | 증상 | 원인 | 해결 |
| --- | --- | --- | --- |
| 1 | 폰에서 "이 연결은 비공개가 아닙니다" 가 **CA 를 신뢰시켜도** 사라지지 않음 | `next dev --experimental-https` 가 만든 인증서 SAN 은 `localhost, 127.0.0.1, ::1, 0.0.0.0` 뿐이라 `192.168.0.143` 이 없음 | 2단계: mkcert 로 **LAN IP 를 SAN 에 넣은** 인증서를 따로 만들고 `--experimental-https-key/-cert` 로 지정 |
| 2 | 페이지는 뜨는데 전부 "인터넷 연결이 불안정해요" | HTTPS 페이지가 `http://localhost:3001` 을 부름 → **혼합 콘텐츠 차단** + 폰의 `localhost` 는 폰 자신 | Next `rewrites` 프록시로 같은 출처 `/api/v1/*` 만 부름 (`dev:lan` 이 자동 설정) |
| 3 | 위를 고쳐도 여전히 실패, 콘솔에 `C:/Program Files/Git/api/v1/...` | Git Bash(MSYS)가 `NEXT_PUBLIC_API_BASE_URL=/api/v1` 의 **선행 슬래시를 경로로 변환** | 환경변수를 셸에서 주지 않는다. `scripts/dev-lan.mjs` 가 Node 안에서 세팅 |

> 인증서를 `next dev --experimental-https` 기본 경로(`certificates/localhost.pem`)에 만들면
> **Next 가 기동할 때 자기 SAN 목록으로 덮어쓴다**(실측). 그래서 파일명을 `lan.pem` 으로 분리했다.

---

## 2. 인증서 생성 (최초 1회, 또는 IP 가 바뀌었을 때)

mkcert 는 `next dev --experimental-https` 가 이미 내려받아 뒀다:
`C:\Users\amole\AppData\Local\mkcert\mkcert-v1.4.4-windows-amd64.exe`
CA 루트도 같은 폴더에 있다(`rootCA.pem` / `rootCA-key.pem`).

```powershell
$mk    = "$env:LOCALAPPDATA\mkcert\mkcert-v1.4.4-windows-amd64.exe"
$env:CAROOT = "$env:LOCALAPPDATA\mkcert"
cd C:\Users\amole\Desktop\aifitcoach\apps\web\certificates
& $mk -key-file lan-key.pem -cert-file lan.pem localhost 127.0.0.1 ::1 192.168.0.174 192.168.0.143
```

**IP 는 여러 개 넣어도 된다.** 유선/무선을 오가면 둘 다 넣어두면 그때마다 재발급하지 않아도 된다.

확인 — SAN 에 폰이 쓸 IP 가 들어갔는지:

```powershell
openssl x509 -in lan.pem -noout -text | Select-String -Context 0,1 "Subject Alternative Name"
```

기대 출력에 지금 쓰는 IP(`IP Address:192.168.0.174`)가 있어야 한다.

> `apps/web/certificates/` 는 **gitignore 되어 있다. 개인 키라 절대 커밋하지 않는다.**

---

## 2.1 IP 가 바뀌었을 때 재발급

DHCP 로 주소가 바뀌거나 유선↔무선을 갈아타면 **SAN 에 그 IP 가 없어서** 폰에서
"이 연결은 비공개가 아닙니다" 가 뜬다. CA 를 이미 신뢰시켜 놨어도 뜬다 — 호스트명 검증에서 걸리는 것이라
CA 신뢰와는 별개다. 아래 4단계면 끝난다.

**폰에 CA 를 다시 설치할 필요는 없다.** 같은 CA 로 재서명하는 것이라 3단계는 건너뛴다.

```powershell
# ① 지금 실제로 닿는 IP 확인 (Status 가 Up 인 어댑터만)
Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } |
  Select-Object InterfaceAlias, IPAddress

# ② 서버를 내린다 (인증서는 기동할 때 읽으므로 살아 있는 서버는 옛 인증서를 계속 내민다)
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# ③ 재발급 — <새IP> 를 ①에서 확인한 값으로 바꾼다
$mk    = "$env:LOCALAPPDATA\mkcert\mkcert-v1.4.4-windows-amd64.exe"
$env:CAROOT = "$env:LOCALAPPDATA\mkcert"
cd C:\Users\amole\Desktop\aifitcoach\apps\web\certificates
& $mk -key-file lan-key.pem -cert-file lan.pem localhost 127.0.0.1 ::1 <새IP>

# ④ 기존 production-LAN 빌드를 다시 띄운다(빌드가 없으면 §4의 build:lan 먼저)
cd C:\Users\amole\Desktop\aifitcoach
pnpm --filter web start:lan
```

**검증 — 여기까지 통과해야 폰으로 넘어간다** (`<새IP>` 를 그대로 치환):

```powershell
# 서버가 실제로 내미는 인증서가 새 IP 를 담고 있고, 체인·호스트명 검증이 통과하는가
openssl s_client -connect <새IP>:3000 -CAfile "$env:LOCALAPPDATA\mkcert\rootCA.pem" -verify_ip <새IP> -brief
```

`Verification: OK` 가 나와야 한다.

> **`-verify_hostname` 을 쓰지 마라.** 그건 DNS 이름만 대조해서 IP SAN 에는 `hostname mismatch` 가 난다.
> IP 는 **`-verify_ip`** 다. (실측으로 헤맨 지점이다.)

> `curl --cacert … https://<새IP>:3000` 은 이 검증에 쓰지 마라. Windows schannel 이 사설 CA 의
> **폐기 상태(CRL/OCSP)를 확인할 수 없어** 체인이 멀쩡해도 `curl: (60)` 로 실패한다. 브라우저 문제가 아니다.
> 도달 여부만 볼 거면 `curl.exe -k` 로 충분하다.

마지막으로 프록시까지:

```powershell
curl.exe -k -o NUL -w "api %{http_code}`n" https://<새IP>:3000/api/v1/dashboard
```

---

## 3. CA 루트를 폰에 신뢰 설치

폰에 `rootCA.pem` 을 옮긴다(카카오톡 나에게 보내기 / 메일 첨부 / AirDrop).
**`rootCA-key.pem` 은 절대 옮기지 않는다** — 그건 CA 개인 키다.

```
C:\Users\amole\AppData\Local\mkcert\rootCA.pem
```

### iOS (iPhone / iPad) — **2단계다. 1단계만 하면 안 된다**

1. **프로파일 설치**: `rootCA.pem` 을 열면 "프로파일이 다운로드됨" 안내 →
   **설정 → 일반 → VPN 및 기기 관리 → mkcert 프로파일 → 설치** (암호 = 기기 잠금 암호)
2. **루트 신뢰 활성화**: **설정 → 일반 → 정보 → 인증서 신뢰 설정** →
   `mkcert <사용자>@<PC>` 스위치를 **켠다**

> 2번을 빼먹으면 프로파일은 설치됐는데 Safari 는 계속 경고를 띄운다. iOS 에서 가장 흔한 실수다.

### Android

1. `rootCA.pem` 을 폰에 저장(다운로드 폴더)
2. **설정 → 보안 및 개인정보 보호 → 추가 보안 설정 → 암호화 및 사용자 인증 정보 →
   인증서 설치 → CA 인증서** → 경고 화면에서 **"무조건 설치"** → 파일 선택
   (삼성 One UI 기준. 제조사마다 메뉴 이름이 조금 다르고, 보통 "인증서 설치" 로 검색된다)
3. 설치 후 **설정 → 보안 → 사용자 인증서**에 `mkcert` 가 보이면 성공

> Android 는 **Chrome 만** 사용자 CA 를 신뢰한다. 앱 내 웹뷰(카톡 인앱 브라우저 등)에서 열지 말고
> 링크를 복사해 **Chrome 에 직접 붙여넣어라.**

---

## 4. 서버 2개 띄우기 — STEP 6은 production-LAN 필수

터미널 2개. 순서는 **API 먼저**.

```powershell
# 터미널 1 — API (:3001)
cd C:\Users\amole\Desktop\aifitcoach
pnpm db:up                                           # postgres/redis 가 안 떠 있으면 (Docker Desktop 먼저 실행)
pnpm --filter api start
```

웹 실행은 목적에 따라 나눈다.

| 명령 | 용도 | Service Worker |
| --- | --- | --- |
| `pnpm --filter web dev:lan` | 코드 수정 중 실기기 화면·터치·반응형 확인 | **비활성** — Next development 모드라 오프라인 셸 판정 금지 |
| `pnpm --filter web build:lan` 후 `pnpm --filter web start:lan` | STEP 6 PWA 설치·기내모드·강제 종료·캐시 검증 | **활성** — 프로덕션 산출물 |
| `pnpm --filter web prod:lan` | 위 build+start를 한 명령으로 실행 | **활성** |

```powershell
# 터미널 2 — production-LAN HTTPS (:3000, 0.0.0.0 바인딩)
cd C:\Users\amole\Desktop\aifitcoach
pnpm --filter web build:lan
pnpm --filter web start:lan
```

`build:lan`은 `NEXT_PUBLIC_API_BASE_URL=/api/v1`을 **Node 프로세스 안에서 빌드에 주입**해 폰용
클라이언트 청크에 same-origin API 경로를 굽는다. `start:lan`은 그 프로덕션 빌드를 `lan.pem`/
`lan-key.pem` HTTPS 서버로 `0.0.0.0:3000`에 제공한다. 셸 환경변수나 `WEB_ORIGIN` 변경은 필요 없다.

### CORS / origin 은 어떻게 되나 — **손댈 게 없다**

`dev:lan`과 production-LAN 모두 브라우저가 `https://192.168.0.174:3000/api/v1/*` 만 부르고,
Next 개발 서버가 서버사이드에서 `http://localhost:3001/v1/*` 로 넘긴다.
**브라우저 관점에선 same-origin 이라 preflight 도 `Origin` 헤더 검사도 발생하지 않는다.**
→ API 의 `WEB_ORIGIN` 을 폰 IP 로 바꿀 필요 없고, 바꾸면 안 된다(로컬 E2E 의 CORS 회귀 스펙이 깨진다).

> 평소 `pnpm --filter web dev`(http://localhost:3000)는 종전대로 `http://localhost:3001/v1` 직통 +
> CORS 를 그대로 탄다. 동작이 바뀌지 않았다.

### PC 에서 먼저 자가진단

```powershell
curl.exe -sk -o NUL -w "page %{http_code}`n"  https://192.168.0.174:3000/
curl.exe -sk -o NUL -w "api  %{http_code}`n"  https://192.168.0.174:3000/api/v1/dashboard
curl.exe -sk -o NUL -w "sw   %{http_code}`n"  https://192.168.0.174:3000/sw.js
pnpm --filter web verify:lan-pwa -- https://192.168.0.174:3000
```

세 HTTP 응답이 `200`이고 검증기가 controller·`afc-pages-v1`·`afc-fonts-v1`·offline reload를
모두 통과해야 폰으로 넘어간다.

| 결과 | 원인 |
| --- | --- |
| `page 000` | :3000 이 안 떠 있거나 방화벽/IP 가 틀렸다 |
| `page 200`, **`api 500`** | **:3001 API 가 안 떠 있다.** 프록시가 상류에 못 붙으면 500 을 돌려준다(실측). 터미널 1 을 확인해라 |
| `api 500` 인데 API 는 떠 있음 | `pnpm db:up` (Docker Desktop) 확인 |

---

## 5. 폰에서 접속

Chrome(Android) / Safari(iOS) 주소창에 직접 입력:

```
https://192.168.0.174:3000
```

- 자물쇠가 뜨고 경고가 없어야 한다. 경고가 뜨면 → 3단계 CA 신뢰(특히 **iOS 2번**)를 다시 본다.
- 경고를 "무시하고 진행" 으로 넘기지 마라. 그러면 secure context 가 아닐 수 있어
  **이번 검증의 목적(함정 1 재발 확인)이 사라진다.**
- 상단 화면에서 콘솔을 볼 수 없으니, 이상하면 PC 에서 위 자가진단부터 다시 한다.

---

## 6. STEP 6 갤럭시 Z 플립6 체크리스트 (production-LAN)

데스크톱 (A)는 Browser Use에 네트워크 offline 전환이 없어 서버 종료로 transport loss를 만들었고,
IndexedDB outbox 개수를 직접 읽지 못해 서버 mutation `applied`·중복 0으로 간접 확인했다. 이 두 한계는
아래 3~6번에서 **실제 기내모드와 OS 강제 종료**로 보완한다.

| # | 확인 | 기대 결과 |
| --- | --- | --- |
| 1 | Android Chrome에서 production-LAN 접속 후 홈 화면 추가 | 인증서 경고가 없고 standalone PWA로 열린다. 삼성 인터넷·인앱 웹뷰는 쓰지 않는다. |
| 2 | 온라인 상태로 앱 셸·카탈로그·세션을 연 뒤 한 번 재실행 | Service Worker가 페이지를 제어하고 이후 오프라인 앱 셸을 제공한다. |
| 3 | 실제 기내모드에서 운동 add 또는 swap 직후 첫 세트를 포함해 N개 기록하고 세션 완료 | 모든 조작이 로컬 성공하고 화면의 루틴·N개 기록·완료 상태가 일치한다. |
| 4 | 기내모드인 채 Android 설정에서 PWA 강제 종료 후 재실행 | 앱 셸이 열리고 루틴·N개 기록·완료 상태가 정확히 복원된다. |
| 5 | 기내모드 해제 직후 다시 켰다가 최종 해제 | 중간 실패에도 기록이 남고 최종 foreground sync가 outbox를 비운다. |
| 6 | 앱을 닫은 채 네트워크만 복구한 뒤, 다시 앱을 열거나 focus | **자동 Background Sync는 기대하지 않는다.** 앱 재실행/focus 시 foreground sync로 반드시 수렴한다(ADR-58). |
| 7 | 두 Chrome 탭에서 서로 다른 세트를 기록 | 두 세트가 서버에 각각 1회 도달하고 performed/planned 중복과 임시 ID 유출이 0이다. |
| 8 | 내부 화면과 커버 스크린에서 세트 행·⋯ 메뉴·RIR 시트·48×48 완료 체크 확인 | 가로 스크롤·겹침·잘림 없이 조작할 수 있다. |
| 9 | 세션/RIR 시트를 연 채 접었다 펴기 | 폭이 즉시 재계산되고 시트·키보드·포커스가 화면 밖으로 벗어나지 않는다. |
| 10 | 운동 자세에서 한 손으로 반복 조작 | 숫자가 읽히고 ⋯·RIR·완료 체크를 오조작 없이 누를 수 있다. |

각 단계 스크린샷과 세션 URL의 UUID를 남긴다. 3·5·7번 뒤에는 PC에서 DB를 직접 조회해 수행 수,
중복, correlation ID 유출, 대시보드·요약·다음 추천을 화면과 함께 판정한다.

### 화면 세부 확인 (이동 경로 포함)

스크린샷은 매 항목마다 찍는다. 저장 경로:

```
C:\Users\amole\Desktop\AFC-화면확인\실기기-2026-08-08\
```

> 상위 폴더에는 **데스크톱 브라우저로 찍은 기존 스크린샷**(`01-온보딩-…`, `03-대시보드-…`, `10-데일리루틴-…`)이
> 이미 있다. 번호가 겹쳐 덮어쓰지 않도록 **날짜 하위 폴더**에 넣는다.

파일명 규칙: `01-rir-바텀시트-ios.png` 처럼 **번호-내용-기기** 로 둔다(나중에 설명 MD 를 붙인다).

폰에서 찍은 스크린샷을 PC 로 옮기는 건 카카오톡 "나에게 보내기" 가 제일 빠르다.

---

### ① RIR 셰브론 탭 → 바텀시트 (**특히 iOS**)

가장 중요하다. 예전에 `<input list>` + `datalist` 로 구현해 **iOS 에서 "목록에서 고르기" 가
완전히 사라진 적**이 있다(CLAUDE.md 함정 2, ADR-39). 지금은 셰브론 + 바텀시트다.

**이동 경로**
1. 대시보드 → 오늘이 운동일이면 **[오늘 루틴 시작]**
   오늘이 휴식일이면 **[그래도 운동하기]** → 부위 선택 → 즉석 세션 생성 (F8-1)
2. 세트 행에서 **RIR 필드 오른쪽 셰브론(⌄)** 을 탭

**볼 것**
- [ ] 셰브론 탭 → **바텀시트가 올라온다** (키보드가 아니라)
- [ ] 0~4 + "모르겠음" 선택지가 **손가락으로 누를 만한 크기**로 나온다
- [ ] 선택하면 시트가 닫히고 값이 필드에 반영된다
- [ ] 필드를 **직접 탭하면 숫자 키패드**가 뜬다(직접 입력도 가능해야 한다)
- [ ] 시트 바깥 탭 / 아래로 스와이프로 닫힌다
- [ ] iOS 에서 시트가 **주소창·홈 인디케이터에 가리지 않는다**

📸 `01-rir-셰브론-ios.png`(닫힌 상태), `02-rir-바텀시트-ios.png`(열린 상태)

---

### ② 세트 행 가독성

**이동 경로**: 같은 세션 화면. 세트를 **2~3개 완료 체크**한 뒤 스크롤.

**볼 것**
- [ ] 한 세트가 **2줄을 넘지 않는다**
- [ ] 무게/반복 입력에 **단위 접미사가 없고**(폭 예산), 라벨로 단위를 안다
- [ ] **목표 RIR** 이 입력과 **같은 세트 행 안**에서 보인다(2줄 배치, AC-RIR-4)
- [ ] 완료된 행은 **접혀서(disclosure)** 요약만 보이고, 탭하면 펼쳐진다
- [ ] 완료 행이 **흐릿하지(opacity) 않다** — 대비 4.5:1 이상이어야 한다(ADR-41)
- [ ] 하단 액션바가 세트 행을 가리지 않고, **홈 인디케이터와 겹치지 않는다**(AC-S1-8)
- [ ] 한 손 엄지로 완료 버튼에 닿는다

📸 `03-세트행-미완료.png`, `04-세트행-완료접힘.png`

**여기서 반드시 같이 확인 — 함정 1 회귀**
- [ ] **세트 완료 체크가 실제로 저장된다** (새로고침해도 남아 있다)
  → 실패하면 secure context 관련 회귀다. 즉시 보고.

---

### ③ ⋯ 단일 메뉴 역할 구분

M-UIb 계약: 카드 헤더에는 ⋯ 트리거 하나만 두고 **교체·통증 기록·삭제**를 단일 메뉴에 모은다.
`[운동 추가]`는 목록 맨 아래에 둔다.

**이동 경로**: 같은 세션 화면 → 운동 카드 헤더.

**볼 것**
- [ ] 운동 카드 헤더에 **⋯ 트리거 하나만** 보인다
- [ ] ⋯ 탭 → **교체·통증 기록·삭제** 메뉴가 열린다
- [ ] 삭제 선택 → **확인 다이얼로그**가 뜬다 (즉시 삭제되지 않는다)
- [ ] **이미 수행 기록이 있는 운동은 삭제가 막히고** 이유가 뜬다
- [ ] **[운동 추가]** 가 운동 목록 **맨 아래**에 있다
- [ ] 손가락으로 ⋯ 메뉴 항목을 오조작하지 않는다

📸 `05-운동카드-헤더.png`, `06-삭제-확인다이얼로그.png`

---

### ④ 온보딩 버튼 위치

**이동 경로**: 온보딩을 처음부터 다시 보려면 **시크릿 창**으로 `https://192.168.0.174:3000` 접속
(로컬 상태가 남아 바로 대시보드로 갈 수 있다).

**볼 것** — 7스텝 전부 넘기면서
- [ ] **[다음]/[이전] 이 항상 화면 같은 위치**에 있다(스텝마다 튀지 않는다)
- [ ] 버튼이 **키보드에 가리지 않는다** (숫자 입력 스텝에서 특히)
- [ ] 엄지로 닿는 하단에 있고 **홈 인디케이터와 겹치지 않는다**
- [ ] 진행 표시(n/7)가 보인다
- [ ] 필수값이 비면 [다음] 이 막히고 **왜 막혔는지** 알려준다
- [ ] 통증 부위 스텝: 칩 다중 선택 + **"해당 없음"** 이 동작한다
- [ ] 스텝 사이 **죽은 공간(빈 여백)이 과하지 않다** ← D-7 판단 근거로 쓴다

📸 `07-온보딩-스텝1.png`, `08-온보딩-통증부위.png`, `09-온보딩-키보드열림.png`

---

## 7. 끝난 뒤

1. 스크린샷을 `C:\Users\amole\Desktop\AFC-화면확인` 에 모은다
2. 같은 폴더에 `README.md` 로 **사진별 설명 + 판정(OK / 문제)** 을 적는다
3. 문제는 **재현 경로 + 기기/브라우저/OS 버전**과 함께 적는다 — 실기기 결함은 그게 없으면 못 고친다
4. 서버 정리: 두 터미널 `Ctrl+C`. 포트가 남으면
   `Get-NetTCPConnection -LocalPort 3000,3001 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`
   (Windows 는 API 가 떠 있으면 `prisma generate`·`pnpm install` 이 EPERM 으로 실패한다 — CLAUDE.md 함정 3)

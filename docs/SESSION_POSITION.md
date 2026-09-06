# 세션의 현재 세트 위치 복원

승인: Sprint03 계약 revision3, 2026-09-05. ADR-76. 세션 한정 세트 append는 별도 티켓04이며 이 문서는 위치 복원의 저장·상호작용 경계를 정의한다.

## 저장하는 위치

기존 IndexedDB `syncMeta`의 별도 namespace/value-version을 사용한다. principal scope와 session ID별로 마지막으로 명시 조작한 exercise ID, planned-set ID 또는 provisional correlation, 완료행의 펼침 상태를 저장한다. 새 Dexie store/schema version이나 서버 위치 API를 추가하지 않는다.

위치를 갱신하는 행동은 입력/focus, 세트 완료·완료취소, 완료행 펼침·접기다. 티켓04의 append 성공도 같은 위치 저장 경계를 사용한다. 단순 렌더·scroll·refetch는 마지막 위치를 덮지 않는다. 정확한 `scrollTop`, 건강값, 미완료 입력 문자열은 위치 값에 넣지 않는다.

완료 전 SetRow의 미커밋 weight/reps/RIR 문자열은 새 영속 범위가 아니다. 기존에 커밋된 수행 draft의 값·completed·client UUID는 그대로 보존한다. 입력 문자열을 보존하려고 performed mutation을 새로 만들지 않는다.

## 복원과 종료

| 상태 | 동작 |
| --- | --- |
| 유효한 저장 행 | session/routine/draft가 준비된 뒤 해당 행으로 한 번 이동한다. 완료행은 저장된 펼침 상태, 미완료행은 기존 입력 UI를 사용한다 |
| 저장 행 삭제 | 같은 운동의 첫 미완료 → 세션의 첫 미완료 → 모두 완료면 요약 순서로 선택한다. 정렬은 운동 순서와 set_no를 따른다 |
| 로딩·읽기 실패·cold offline | 유효한 빈 세션과 구분한다. 불확실한 결과로 fallback 위치를 저장하지 않는다 |
| 이미 사용자 조작이 시작됨 | 늦은 hydration/GET/ACK가 이전 위치로 되돌리거나 입력 focus를 다시 빼앗지 않는다 |
| 성공한 세션 종료 | 활성 위치를 정리하고 요약을 기본 화면으로 표시한다. 미해결 완료 요청은 성공 종료로 취급하지 않는다 |
| 당일 완료 세션 명시 편집 | 요약에서 사용자가 편집에 진입한 뒤 새 조작 위치를 기록한다. 기존 completedAt/수행 사실을 위치 기능이 바꾸지 않는다 |
| 다른 세션·404/410·깨진 저장 version | 과거 세션의 위치/타이머를 현재 세션에 적용하지 않는다. 기존 draft/outbox를 복원 편의로 삭제하지 않는다 |

복원은 의미 있는 행으로 이동하며 키보드를 자동으로 반복 열지 않는다. 같은 exercise가 삭제 후 재추가되어도 과거 correlation을 새 planned ID에 붙이지 않는다. fallback 선택과 과거 actual/timer/expanded identity의 승격은 별개다.

진행 중 세션의 모든 세트가 완료되어 요약으로 fallback하더라도 유효한 기존 휴식 타이머는 같은 화면 위에 유지한다. 루틴/요약 분기마다 타이머를 새로 만들지 않고 단일 sheet를 표시한다. 종료시각·identity·완료 피드백을 재설정하지 않으며 타이머를 닫은 뒤에도 요약은 유지한다. 삭제된 planned membership 등으로 무효인 타이머는 표시하지 않는다.

요약은 현재 세션에 속한 수행 사실을 표시한다. 로컬의 커밋된 수정·완료취소가 있으면 이를 우선하고, 로컬 기록이 없는 행은 서버의 `performed_set.completed=true` 실제값을 읽어 표시한다. 따라서 빈 context의 서버 완료 기록을 0으로 표시하지 않는다. 이 보충은 요약의 읽기 전용 계산이며 새 draft/client UUID/outbox를 만들지 않는다. 도움 무게·맨몸·시간은 외부 kg 볼륨에 산입하지 않고 저장 snapshot의 의미를 따른다.

## ACK와 타이머

provisional→server mapping ACK transaction에서 위치를 draft·outbox 실행 참조·mirror·routine·timer/alias와 함께 canonical ID로 승격한다. ACK 이후 늦게 저장되는 위치도 alias를 같은 저장 transaction에서 확인한다. 다른 session에서 도착한 응답은 저장된 자기 scope만 갱신하며 현재 화면을 바꾸지 않는다.

위치와 타이머 자격은 현재 권위 planned membership 또는 유효 pending routine membership를 확인한다. 삭제된 행의 completed draft/old alias/timer만 남았다고 그 행을 복원하지 않는다. 타이머의 ends_at/total_sec를 위치 복원으로 다시 시작하거나 수행값으로 덮지 않는다. 완료 draft와 timer 저장이 별개인 기존 구간을 하나의 원자 저장이라고 주장하지 않는다.

## 검증 경계

- 실제 SessionScreen에서 active 미완료행과 펼친 완료행 각각을 40초 실제 background, route A→B→A, reload 후 확인한다. 커밋된 draft/client UUID, timer ends_at/total_sec, position identity는 같고 남은 초만 경과시간을 반영한다.
- 소유 disposable persistent profile에서 durable transaction 완료를 관측한 뒤 브라우저 process를 종료하고 같은 origin/storage로 재실행한다. 미커밋 write까지 임의 kill에서 보존된다고 주장하지 않는다.
- 빈 isolated browser context는 이전 local 데이터가 없는 안전 초기 상태다. `storageState`의 IndexedDB 이식은 snapshot 실험이며 실제 process/disk 복원 증거를 대신하지 않는다.
- ACK 전/중/후 위치 저장, 늦은 timer/draft 저장, 두 탭, 삭제 membership, 완료 및 명시 편집을 실제 배선으로 확인한다. 위치 배선 또는 ACK remap을 끊는 mutation이 실패해야 한다.
- 360/390/430px의 대상 행 가시성·keyboard·overflow·axe를 검증한다. 물리 Galaxy 검증은 별도의 최종 기기 QA이며 자동 브라우저 통과로 대체하지 않는다.

현행 UI는 기존 dev-user principal scope를 사용한다. 저장 계층의 scope 격리를 다계정 인증 지원으로 해석하지 않으며 auth/CSRF/PIPA 정책은 변경하지 않는다.

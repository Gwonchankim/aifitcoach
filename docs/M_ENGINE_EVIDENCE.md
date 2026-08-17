# M-ENGINE′ 근거 문서 — 엔진 규칙 3영역

> 목적: D-3에서 보류한 엔진 수식 변경(R-08/09/10/25)의 근거를 마련하고,
> 현행 규칙(근비대 RIR 1~2 / 스트렝스 2~4, 주간 볼륨 10~20, 볼륨감소형 디로드)이
> 최근 문헌에 부합하는지 검증한다.
> 조사 범위: 2023~2026, 메타분석·메타회귀·RCT 우선. 조사일 2026-08-17.
> **이 문서는 근거만 정리한다. 규칙 변경은 골든 테스트·rules_version과 함께 별도 승인한다.**

---

## 요약 — 세 영역의 결론

| 영역 | 현행 규칙 | 근거 판정 | 조치 |
|---|---|---|---|
| RIR 근접도 | 근비대 1~2 / 스트렝스 2~4 | **지지됨** | 변경 없음 |
| 주간 볼륨 | 10~20 "권장" 표시 | **하한 지지, 상한 표현 과함** | 표현 완화(경고→중립) |
| 디로드 | 5~6주 주기·볼륨감소·강도유지 | **주기 기반이 약함** | 주기→자기조절 전환 |

핵심: **세 영역 중 엔진 수식을 바꿔야 하는 것은 없다.** 디로드의 트리거 방식과 볼륨 표시 문구만
조정 대상이며, 둘 다 엔진이 아니라 표시·정책 계층에서 처리 가능하다.

---

## 1. 세트당 근접도(RIR)와 실패 도달

### 1.1 핵심 문헌

**[E1] Robinson ZP, Pelland JC, Remmert JF, Refalo MC, Jukic I, Steele J, Zourdos MC (2024).**
*Exploring the Dose-Response Relationship Between Estimated Resistance Training Proximity to Failure,
Strength Gain, and Muscle Hypertrophy: A Series of Meta-Regressions.* Sports Med 54(9):2209-2231.
doi:10.1007/s40279-024-02047-8
- 설계: 다수준 메타회귀. 비대 55연구 / 스트렝스 67연구. RIR을 연속 변수로 추정.
- 결과: **비대는 RIR이 낮을수록(실패에 가까울수록) 증가**하는 유의한 음의 기울기.
  **스트렝스는 근접도의 이득이 없음.**
- 저자 주의: 탐색적 분석이며 RIR은 연구 기술에서 추정한 값.

**[E2] Refalo MC, Helms ER, Trexler ET, Hamilton DL, Fyfe JJ (2023).**
*Influence of Resistance Training Proximity-to-Failure on Skeletal Muscle Hypertrophy:
A Systematic Review with Meta-analysis.* Sports Med 53(3):649-665. doi:10.1007/s40279-022-01784-y
- 15연구 메타분석. 실패 근접 세트가 비대에 **소폭** 우위(ES 0.15~0.21).

**[E3] Refalo MC, Nuckols G, Galpin AJ, Gallagher IJ, Hamilton DL, Fyfe JJ (2024).**
*Similar muscle hypertrophy following eight weeks of resistance training to momentary muscular failure
or with repetitions-in-reserve in resistance-trained individuals.* J Sports Sci 42(1):85-101.
doi:10.1080/02640414.2024.2321021
- 설계: 훈련자 18명(남12/여6), 8주, 주 2회. 좌우 하지 무작위 배정.
  레그프레스·레그익스텐션을 (i) 실패까지 vs (ii) **2-RIR·1-RIR**로 수행.
- 결과: **대퇴사두 비대 유사**. 실패군은 급성 신경근 피로(반복·속도 손실)가 더 큼.

### 1.2 우리 규칙에 대한 판정

**근비대 target RIR 1~2 — 지지됨. 변경 불필요.**
- [E3]이 정확히 1~2 RIR 프로토콜을 실패군과 직접 비교해 **동등한 비대**를 보였다.
- [E1][E2]는 더 낮은 RIR이 소폭 유리함을 시사하나 효과크기가 작고(ES 0.15~0.21),
  [E3]에서 실패군의 신경근 피로가 더 컸다. **소폭의 비대 이득과 피로·부상 위험의 교환**이며,
  자가보고 RIR의 오차(초보 과소평가)를 감안하면 1~2가 실용적 최적점이다.
- 현행 "마지막 세트·고립운동에서 0~1 허용"도 [E1][E2]와 정합적이다.

**스트렝스 target RIR 2~4 — 지지됨. 변경 불필요.**
- [E1]에서 **스트렝스는 근접도의 이득이 없다.** 즉 실패에 가까이 갈 이유가 없고,
  더 큰 RIR로 신경 피로를 줄이는 편이 세션 간 회복과 빈도 확보에 유리하다.

### 1.3 M-ENGINE′ 적용

- **골든 테스트 변경 없음.** 현행 target RIR 값이 근거에 부합한다.
- 문서 보강만: `RECOMMENDATION_ENGINE.md`의 근거 인용을 [E1][E2][E3]로 갱신.
- 신뢰도: **높음**(메타회귀 + 직접 RCT 양쪽이 같은 방향).

---

## 2. 주간 볼륨(근육군당 hard set)의 용량-반응

### 2.1 핵심 문헌

**[E4] Pelland JC, Remmert JF, Robinson ZP, Hinson SR, Zourdos MC (2026).**
*The Resistance Training Dose Response: Meta-Regressions Exploring the Effects of Weekly Volume and
Frequency on Muscle Hypertrophy and Strength Gains.* Sports Med 56(2):481-505.
doi:10.1007/s40279-025-02344-w (Epub 2025-12-04)
- 설계: 67연구 2,058명. 세트를 direct/indirect로 분류 후(indirect는 0.5 가중) 다수준 메타회귀.
- 결과:
  - 볼륨 → 비대·스트렝스 **모두 증가**(사후확률 100%).
  - 단 **수확체감(diminishing returns)**, 스트렝스에서 체감이 더 뚜렷.
  - 빈도 → **비대에는 효과 미미**(사후확률 100% 미만, 무효과와 양립).
    **스트렝스는 빈도 증가로 향상**(사후확률 100%, 역시 수확체감).

**[E5] Schoenfeld BJ, Ogborn D, Krieger JW (2017).**
*Dose-response relationship between weekly resistance training volume and increases in muscle mass.*
J Sports Sci 35(11):1073-1082.
- 15연구 34군. 세트당 ES +0.023(≈0.37% 추가 증가)의 **점진적 용량-반응**.

### 2.2 우리 규칙에 대한 판정

**하한(10세트) — 지지됨.**
- [E4][E5] 모두 볼륨 증가에 따른 단조 증가를 보인다. 10세트 미만은 명백히 저용량 구간이다.

**상한(20세트) 표현 — 근거보다 강함. 수정 권장.**
- [E4]의 결론은 **고원(plateau)이 아니라 수확체감**이다. 즉 20세트를 넘어도 이득은 계속되며
  증가폭만 작아진다. 따라서 "20 초과 = 과다"라는 **경고성 표현은 근거를 넘어선다.**
- 또한 [E4]는 direct/indirect 가중(간접 세트 0.5)을 적용했다. 우리 D-35는
  "주동근에 완료 세트 1개씩, 보조근 제외"로 **간접 세트를 0으로 계산**한다.
  즉 우리 집계는 문헌 대비 **보수적(과소 계상)**이며, 같은 10~20 라벨을 붙이면
  사용자는 실제보다 적게 훈련한다고 오인할 수 있다.

**빈도 — 목표별로 다르게 취급할 근거가 있음.**
- 비대: 볼륨 등가 시 빈도 영향 미미 → 분할은 사용자 편의로 정해도 무방(현행 유지 정당).
- 스트렝스: 빈도 증가가 유리 → 스트렝스 목표에서 **같은 주 리프트 노출을 주 2회 이상**
  보장하는 것이 근거에 부합. 현행 분할 규칙(days 2~3 full_body, 4~5 upper_lower, 6 PPL)이
  이를 자연히 충족하는지 점검 필요.

### 2.3 M-ENGINE′ 적용

- **엔진 수식 변경 없음.** 볼륨은 표시·집계 영역이다.
- 조치 1(표시): "권장 10–20"을 **경고가 아닌 중립 참조 구간**으로 표현.
  D-36에서 스트렝스에 이미 "실제값만 표시, 경고 없음"으로 갔다 — 근비대도 같은 톤으로 통일.
  초과 시 붉은 경고 대신 "이 구간을 넘었습니다(개인차 있음)" 수준.
- 조치 2(집계 문서화): D-35의 "보조근 제외"가 문헌의 direct/indirect 0.5 가중과 다르다는 점을
  `M4_CONTRACT.md`에 명시. 변경은 하지 않되 라벨 해석 차이를 기록.
- 조치 3(검토): 스트렝스 목표에서 주 리프트 빈도가 주 2회 이상인지 프로그램 생성 규칙 점검.
- 신뢰도: **높음**(대규모 최신 메타회귀).

---

## 3. 디로드 — 필요성·주기·방식 (R-25 충돌 지점)

### 3.1 핵심 문헌

**[E6] Coleman M, Burke R, Benavente C, et al. / Schoenfeld BJ (2024).**
*Gaining more from doing less? The effects of a one-week deload period during supervised resistance
training on muscular adaptations.* PeerJ 12:e16777. doi:10.7717/peerj.16777
- 설계: 훈련 경력 1년 이상 39명(남29/여10). 9주 고볼륨 프로그램 중간에
  **1주 완전 중단(DELOAD)** vs 연속 훈련(TRAD) 무작위 배정.
- 결과: **비대 차이 없음. 스트렝스는 DELOAD군이 오히려 불리.**
- 저자 결론(직접 인용 취지): 필요를 느끼지 않는 참가자에게 디로드를 수행시키는 것은
  **이득보다 해가 될 수 있으며**, 사전 계획형보다 **자기조절형(autoregulated) 디로드**가
  더 타당할 수 있다.

**[E7] Rogerson D, Nolan D, Korakakis PA, Immonen V, Wolf M, Bell L (2024).**
*Deloading Practices in Strength and Physique Sports: A Cross-sectional Survey.*
Sports Med Open 10:26.
- 경기 선수 246명(경력 8.2±6.2년). 전원이 디로드를 사용.
- 실태: 기간 **6.4±1.7일**, 주기 **5.6±2.3주**. 주된 이유는 에너지·피로 관리.
- 중요: **다수가 "디로드 없이도 진행할 수 있다고 느낀다"**고 응답 → 필수 전제가 아님.

**[E8] Bell L, Nolan D, Immonen V, Helms E, Dallamore J, Wolf M, Rogerson D.**
*A Practical Approach to Deloading: Recommendations and Considerations.* Strength Cond J.
- 실무 권고: 디로드 시 **(a) 상대강도 %1RM 약 10% 감소**, 또는
  **(b) 세트 수 감소 / RIR 증가(절대부하 유지하며 반복 감소)** 등을 단독 또는 조합.
- 즉 **볼륨 감소형과 강도 감소형 모두 통용되는 방식**이다.

### 3.2 우리 규칙에 대한 판정

**"볼륨 감소형·강도 유지" — 유효하나 배타적이지 않음.**
- [E8]은 강도 10% 감소나 RIR 증가도 정당한 옵션으로 제시한다.
- 따라서 **R-25(디로드 시 목표 RIR 2→4)는 "근거 없는 변경"이 아니다.**
  D-3 보류 당시 내가 "우리 스펙과 충돌"이라고 본 것은 절반만 맞다 —
  충돌이 아니라 **동일 목적의 다른 변형**이다.
- 다만 우리 스펙의 "강도 유지"에는 별도 근거(Schoenfeld 계열의 볼륨 감소형 권고)가 있으므로
  기본값을 바꿀 필요는 없다.

**"5~6주 주기" — 근거가 약함. 전환 권장.**
- [E7]의 5.6±2.3주는 **선수들의 관행(실태)**이지 효과 검증 결과가 아니다.
- [E6]은 **사전 계획형 디로드가 이득이 없고 스트렝스에 불리할 수 있음**을 직접 보였다.
- 결론: **달력 기반 주기 제안은 근거가 약하고, 피로 신호 기반 자기조절이 더 타당하다.**

**우리 설계는 이미 옳은 방향에 있다.**
- 현행 `DELOAD_SUGGESTED`는 "반복 2세션 연속 하락 / e1RM 2주 정체·하락 / 주관 피로↑ /
  수면↓ / 통증↑ 중 3개 이상"이라는 **자기조절 트리거**다. [E6]의 권고와 정확히 일치한다.
- 문제는 스펙에 함께 적힌 "주기 대략 5~6주"다. 이 문구가 달력 기반 제안으로 구현되면
  [E6]과 어긋난다.

### 3.3 M-ENGINE′ 적용

- **엔진 수식 변경 없음.** 트리거 방식만 정리.
- 조치 1: `RECOMMENDATION_ENGINE.md`의 "주기 대략 5~6주"를
  **"참고: 실태 조사상 5~6주 간격이 흔하나([E7]), 사전 계획형 디로드는 이득이 불확실하므로
  ([E6]) 본 엔진은 달력이 아니라 피로 신호로 제안한다"**로 개정.
- 조치 2: 달력 기반 디로드 제안이 코드에 구현돼 있다면 제거. (실측 필요 — 현재 P1 미구현일 가능성)
- 조치 3(R-25 재판정): 디로드 시 RIR 증가는 **선택적 변형으로 채택 가능**.
  단 기본값은 볼륨 감소 유지. 채택 시 골든 케이스 신설 + rules_version 상향 필요.
- 신뢰도: **중간~높음**(직접 RCT 1편 + 대규모 실태조사 + 실무 리뷰. RCT는 미숙련~중급 대상,
  9주 단일 디로드라 장기·고급자 일반화에는 한계).

---

## 4. D-3 보류 항목 재판정

| 항목 | D-3 당시 판단 | 이번 조사 후 |
|---|---|---|
| R-25 디로드 RIR 2→4 | "우리 스펙과 충돌, 근거 불명" | **정정: 통용되는 변형이며 근거 있음**([E8]). 선택적 채택 가능, 기본값은 볼륨 감소 유지 |
| R-08 증량 5% | "출처 불명, step_kg와 이원화" | **미해결.** 이번 조사 범위 밖. 별도 조사 필요 |
| R-09 공백 복귀 −10% | "출처 불명" | **미해결.** 별도 조사 필요(detraining/retraining 문헌) |
| R-10 체지방·나이·성별 반영 | "상당한 확장, 근거 필요" | **미해결.** 별도 조사 필요 |

**R-08/09/10은 여전히 보류.** 이번 3영역과 성격이 다르므로 별도 조사 티켓으로 분리한다.

---

## 5. 실행 제안 (승인 필요)

1. **엔진 수식·골든 테스트 변경 없음** — 세 영역 모두 현행 규칙이 근거에 부합한다.
2. **문서 개정 3건**
   - `RECOMMENDATION_ENGINE.md`: RIR·볼륨·디로드 근거 인용 갱신, 디로드 "5~6주 주기" 문구 개정.
   - `M4_CONTRACT.md`: 볼륨 라벨을 경고→중립 표현으로, D-35 집계와 문헌 가중치 차이 명시.
   - `PROGRESS.md`: R-25 재판정 기록.
3. **점검 1건** — 스트렝스 목표에서 주 리프트 빈도가 주 2회 이상인지 프로그램 생성 규칙 확인([E4]).
4. **보류 유지** — R-08/09/10은 별도 조사 티켓.

---

### 등록된 후속 티켓 (2026-08-17)

| 티켓 | 범위 | 상태 |
|---|---|---|
| `MENG-DOC-1` | `RECOMMENDATION_ENGINE.md`의 RIR·볼륨·디로드 인용 갱신과 “5~6주 주기” 문구를 자기조절 우선으로 개정 | 등록 · 미착수 |
| `MENG-DOC-2` | `M4_CONTRACT.md`의 볼륨 라벨을 경고에서 중립 참조로 바꾸고 D-35 직접 세트 집계와 문헌의 간접 세트 0.5 가중 차이를 명시 | 등록 · 미착수 |
| `MENG-DOC-3` | `PROGRESS.md`의 R-25 재판정 기록을 M-ENGINE′ 실행 결정과 연결하고, 선택적 채택 시 골든 케이스·`rules_version` 변경 범위를 확정 | 등록 · 미착수(이번 반영은 근거 접수 기록만) |
| `MENG-AUDIT-1` | 스트렝스 프로그램의 주 리프트 주 2회 노출과 운동 선택 규칙의 계약 일치 여부를 교정안·회귀 테스트까지 확정 | **완료** — 난이도 상한 하드 필터·compound 우선·주 5일 upper/lower 3/2, red-first 및 뮤턴트 증명 |

위 티켓은 근거를 실행 계약으로 옮기는 작업이다. 근거 문서 접수 시점에는 변경하지 않았고,
이후 별도 승인으로 `MENG-AUDIT-1`만 실행했다. 엔진 수식·골든·`rules_version`·표시 문구를 다루는
`MENG-DOC-1~3`은 계속 미착수다.

---

## 부록. 인용 목록

- [E1] Robinson et al. 2024. Sports Med 54(9):2209-2231. doi:10.1007/s40279-024-02047-8
- [E2] Refalo et al. 2023. Sports Med 53(3):649-665. doi:10.1007/s40279-022-01784-y
- [E3] Refalo et al. 2024. J Sports Sci 42(1):85-101. doi:10.1080/02640414.2024.2321021
- [E4] Pelland et al. 2026. Sports Med 56(2):481-505. doi:10.1007/s40279-025-02344-w
- [E5] Schoenfeld et al. 2017. J Sports Sci 35(11):1073-1082.
- [E6] Coleman/Schoenfeld et al. 2024. PeerJ 12:e16777. doi:10.7717/peerj.16777
- [E7] Rogerson et al. 2024. Sports Med Open 10:26.
- [E8] Bell et al. A Practical Approach to Deloading. Strength Cond J.

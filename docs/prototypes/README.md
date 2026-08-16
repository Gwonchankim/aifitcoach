# 프로토타입 추출본

원본은 브라우저 런타임·압축 자산을 포함한 약 22MB짜리 오프라인 번들이므로 저장소에 넣지 않는다. 이 디렉터리에는
각 원본의 `__bundler/template` payload에서 다음만 결정론적으로 추출한다.

- `*.template.html`: 실행 가능한 `<script>`와 폰트 바이너리 참조를 제거한 앱 마크업·인라인 스타일
- `*.copy.json`: 정적 마크업과 상태 데이터에 들어 있던 한글 카피(원본 등장 순서, 중복 제거)
- `manifest.json`: 원본 파일명·바이트 수·SHA-256과 추출본 통계

재추출:

```powershell
node scripts/extract-prototypes.mjs --source-dir "C:\path\to\originals"
node scripts/extract-prototypes.mjs --source-dir "C:\path\to\originals" --check
```

`--check`는 파일을 쓰지 않고 현재 추출물이 같은 입력에서 바이트 단위로 재현되는지 검증한다. 원본이 갱신되면
`manifest.json`의 SHA-256 변경과 추출 diff를 함께 리뷰한다. 추출본은 동작 가능한 앱이 아니며, 디자인·카피 계약을
검토하기 위한 자료다. M-4′ 구현에서는 `M4_CONTRACT.md`와 D-39 서버 권위 display gate가 프로토타입보다 우선한다.

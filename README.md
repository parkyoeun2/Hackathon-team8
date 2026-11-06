# Hackathon-team8

## P5 통합 실행

FastAPI 한 서버가 HTML 5개와 `/static`의 CSS·JavaScript·이미지를 제공하고, 같은 출처의 `/api/routes`, `/api/conditions/parse`를 처리합니다. Flask나 별도 프론트 빌드 서버는 사용하지 않습니다. 기존 브랜치의 파일은 그대로 두고 `integration/p5-frontend-backend` worktree에서 작업했습니다.

### 현재 PC의 PowerShell

작업 폴더를 통합 worktree로 옮깁니다. 원본 저장소 루트에서 실행하는 명령입니다.

```powershell
Set-Location .\.integration\p5-frontend-backend
$naranhiPython = (Resolve-Path '..\..\backend\.venv\Scripts\python.exe').Path
& $naranhiPython -B -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000
```

기존 8000 서버가 실행 중이면 기존 터미널에서 종료하거나 `--port 8001`로 실행합니다. 브라우저 주소의 포트도 같은 값으로 맞춥니다. 서버가 `Application startup complete`를 표시하면 `http://127.0.0.1:8000/`에서 시작합니다. `/docs`에서 API만 따로 확인할 수 있습니다. 실제 다른 기기 접속은 별도 네트워크·호스트 설정이 필요합니다.

다른 PC에서는 Python 3.10+ 실행 파일을 확인해 `backend/.venv`를 생성하고 `backend/requirements.txt`를 설치한 뒤 해당 가상환경 Python으로 같은 명령을 실행합니다. 앱 자체에는 Node.js가 필요하지 않습니다.

### 화면 흐름

1. 프로필: 네 토글을 API 값으로 바꾸어 브라우저 localStorage에 저장합니다. 편안한 길 우선은 `comfortFirst`와 `detourAllowed`를 함께 설정합니다.
2. 홈: 검증된 시연 장소 두 곳을 선택합니다. 이름을 자유 입력하거나 외부 지오코딩 서비스를 호출하지 않습니다.
3. 오늘 상태: 텍스트가 있으면 규칙 기반 분석 결과·경고를 확인하고 수정한 뒤 적용합니다. 텍스트가 없으면 분석 화면을 건너뜁니다. 원문은 서버 로그·브라우저 저장소에 보관하지 않습니다.
4. 비교: 실제 API 경로 1~3개를 반환된 이름으로 표시합니다. 동일 경로 안내와 별개로 대안은 유지합니다.
5. 상세·경고 상태: 선택한 경로 ID의 좌표·지표·경고를 표시합니다. 결과와 선택 ID는 현재 탭 sessionStorage에 보관하며 결과가 없으면 다시 검색하도록 안내합니다.

`null`은 정보 미확인으로 표시하고 실제 0과 구분합니다. `gradeCoveragePercent`는 경사 데이터의 거리 확인율이며 경사율이 아닙니다. 확인된 계단 0개도 무장애 경로를 보장하지 않습니다. 소요시간은 제공하지 않습니다.

경로도는 **실제 API의 `[lng, lat]` 좌표로 그린 SVG**입니다. 배경 도로지도·지오코딩·실시간 길 안내는 제공하지 않습니다. 선택 완료는 현재 화면에서의 경로 선택 확인이며 서버에 이력을 저장하지 않습니다. 지도 예시 SVG로 실제 결과를 대체하지 않습니다.

### 테스트

통합 worktree에서 기존 백엔드 테스트와 새 정적 서빙 테스트를 실행합니다.

```powershell
& $naranhiPython -B -m unittest discover -s backend/tests -v
```

기존 경로 테스트는 `docs/example_input.json`, `docs/example_output.json`을 읽습니다. 원본 미추적 자료에서 내용 그대로 복사했으며 테스트가 덮어쓰지 않습니다. 이 두 JSON도 통합 소스와 함께 버전 관리해야 다른 PC에서 테스트할 수 있습니다. 원본 엑셀은 이번 worktree에 복사하지 않았습니다.

실제 브라우저 테스트는 Playwright가 있는 테스트 환경에서 실행합니다. 성공 응답은 실제 FastAPI/A 함수만 사용하고, 오류 표시 한 경우에만 404를 주입합니다. 앱의 실행 의존성에는 Playwright를 추가하지 않았습니다.

```powershell
$env:NARANHI_TEST_URL = 'http://127.0.0.1:8000'
# 현재 PC에서 확인한 테스트 도구 경로입니다. 다른 PC에서는 설치된 경로로 바꿉니다.
$env:NARANHI_PLAYWRIGHT_MODULE = 'C:\Users\kmj00\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
$env:NARANHI_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$naranhiNode = 'C:\Users\kmj00\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $naranhiNode .\tests\browser_p5.cjs
```

스크린샷과 브라우저 보고서는 Git에서 제외한 `.p5-artifacts/`에 생성됩니다. `backend/test_route_service_v02.py`는 예시 JSON을 쓰므로 직접 실행하지 않습니다.

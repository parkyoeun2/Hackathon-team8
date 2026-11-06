# Hackathon-team8

## P5/P6 통합 실행

FastAPI 한 서버가 HTML 5개와 `/static`의 CSS·JavaScript·이미지를 제공하고, 같은 출처의 `/api/routes`, `/api/conditions/parse`를 처리합니다. Flask나 별도 프론트 빌드 서버는 사용하지 않습니다. P5 기준 커밋은 `a338762`이며, P6는 같은 worktree의 `feature/p6-leaflet-integration` 브랜치에서 작업합니다. 기존 P5 브랜치는 보존합니다.

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

결과 화면에는 **실제 API의 `[lng, lat]` 좌표로 그린 SVG 미리보기**를 표시합니다. 미리보기 클릭·키보드 Enter 또는 “이 경로 보기”로 선택한 `routeId`의 상세 화면으로 이동합니다. 상세 화면만 Leaflet 1.9.4와 OpenStreetMap 배경지도를 사용하며, 정보 확인 화면은 기존 SVG를 유지합니다.

상세 지도는 실제 좌표를 `[lat, lng]`로 변환하여 경로선을 그리고 선택 경로를 강조합니다. 출발·도착 마커는 경로 첫·끝 보행 노드이며 입력한 장소 좌표와 다를 수 있습니다. Leaflet 자산을 불러오지 못하면 지도 오류를 안내하고 지표·경고·뒤로가기·경로 선택 기능은 유지합니다. 타일 실패도 별도로 안내합니다.

Leaflet CSS·JS는 `https://unpkg.com/leaflet@1.9.4/dist/`의 고정 버전을 SRI로 확인합니다. 타일은 `https://tile.openstreetmap.org/{z}/{x}/{y}.png`를 사용하고 지도 안의 OpenStreetMap 출처 표기를 유지합니다. 배경지도에는 인터넷 연결이 필요합니다. 지오코딩·GPS·쉼터·실시간 길 안내는 이번 변경에 포함하지 않습니다. 선택 완료는 탭 안의 선택 확인이며 서버에 이력을 저장하지 않습니다.

프론트팀 `Hackathon-team8-leaflet.zip`에서 좌표 변환·경로선·끝점 마커·화면 맞춤 방식을 선별했습니다. ZIP SHA256은 `97c7a1b3f7e74d7988c97cd4b6ea42d1bb689822c74636c3efb0877300ef6f79`입니다. ZIP의 backend, result/check Leaflet 적용, 경사 설명 그림은 가져오지 않았습니다. 참고: [Leaflet 1.9.4](https://leafletjs.com/reference-1.9.4.html), [OSM 타일 정책](https://operations.osmfoundation.org/policies/tiles/).

### 테스트

통합 worktree에서 기존 백엔드 테스트와 새 정적 서빙 테스트를 실행합니다.

```powershell
& $naranhiPython -B -m unittest discover -s backend/tests -v
```

기존 경로 테스트는 `docs/example_input.json`, `docs/example_output.json`을 읽습니다. 원본 미추적 자료에서 내용 그대로 복사했으며 테스트가 덮어쓰지 않습니다. 이 두 JSON도 통합 소스와 함께 버전 관리해야 다른 PC에서 테스트할 수 있습니다. 원본 엑셀은 이번 worktree에 복사하지 않았습니다.

실제 브라우저 테스트는 Playwright가 있는 테스트 환경에서 실행합니다. 성공 응답은 실제 FastAPI/A 함수만 사용합니다. 오류 화면 검사에서는 404 또는 지도 자산·타일 실패만 주입합니다. 실제 Leaflet 레이어 좌표·선택 강조·스냅된 끝점, SVG 미리보기의 클릭·키보드 이동도 검증합니다. 보고서의 `backgroundVerified`는 실제 OSM 타일 표시 확인 여부이며, 지도 코드 검증과 구분합니다. 앱의 실행 의존성에는 Playwright를 추가하지 않았습니다.

```powershell
$env:NARANHI_TEST_URL = 'http://127.0.0.1:8000'
$env:NARANHI_TEST_ARTIFACTS = '.p5-artifacts/p6-leaflet'
# 현재 PC에서 확인한 테스트 도구 경로입니다. 다른 PC에서는 설치된 경로로 바꿉니다.
$env:NARANHI_PLAYWRIGHT_MODULE = 'C:\Users\kmj00\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
$env:NARANHI_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$naranhiNode = 'C:\Users\kmj00\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $naranhiNode .\tests\browser_p5.cjs
```

스크린샷과 브라우저 보고서는 Git에서 제외한 `.p5-artifacts/`에 생성됩니다. `backend/test_route_service_v02.py`는 예시 JSON을 쓰므로 직접 실행하지 않습니다.

# Hackathon-team8

## P5/P6/P7/P8 통합 실행

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
2. 홈: 시연 장소 네 곳 중 서로 다른 출발지와 목적지를 선택합니다. 이름을 자유 입력하거나 외부 지오코딩 서비스를 호출하지 않습니다.
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
$env:NARANHI_TEST_ARTIFACTS = '.p5-artifacts/p8-route-explanations'
# 현재 PC에서 확인한 테스트 도구 경로입니다. 다른 PC에서는 설치된 경로로 바꿉니다.
$env:NARANHI_PLAYWRIGHT_MODULE = 'C:\Users\kmj00\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
$env:NARANHI_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$naranhiNode = 'C:\Users\kmj00\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $naranhiNode .\tests\browser_p5.cjs
```

스크린샷과 브라우저 보고서는 Git에서 제외한 `.p5-artifacts/`에 생성됩니다. `backend/test_route_service_v02.py`는 예시 JSON을 쓰므로 직접 실행하지 않습니다.


### P7 시연 장소

P7 작업 브랜치는 `feature/p7-demo-places`이며 기준은 P6 커밋 `f167999`입니다. 기존 JSON 구조와 두 장소를 유지하고 다음 네 곳을 제공합니다.

| ID | 장소 | 위도 | 경도 |
|---|---|---:|---:|
| `duksung_gate` | 덕성여대 정문 | 37.6517 | 127.0149 |
| `hyomun_gate` | 효문중고 출입구 | 37.6526 | 127.0174 |
| `duksung_dorm` | 덕성여대 기숙사 | 37.6491330337407 | 127.022277801401 |
| `april19_station_exit1` | 4·19민주묘지역 1번 출구 | 37.64974340377622 | 127.01372260345704 |

**역 1번 출구와 실제 4·19민주묘지 입구는 다른 장소입니다.** 목록에는 역 출구를 추가했습니다.

A가 계산하는 `distanceM`은 보행 네트워크 경로의 구간 길이 합입니다. 입력 지점에서 최근접 보행 노드까지의 직선거리(기숙사 약 50.6m, 역 출구 약 90.3m)는 실제 이동 가능한 동선이나 보행 거리로 검증되지 않았으며, 경로 거리에 임의로 더하지 않습니다.

기본 프로필의 기숙사 ↔ 역 출구 대표 경로는 A 기준 1121.3m, 좌표 53개, 확인된 계단 0개, 경사 데이터 확인율 19.7%, `sameRoute:true`입니다. 이 값은 접근성이나 실제 현장 상태를 보장하지 않습니다. 화면은 항상 API가 반환한 값을 표시합니다.

추가 HTTP 테스트는 네 장소의 서로 다른 12개 방향 × 일반·캐리어·유모차 3조건을 검증합니다. Chrome 테스트는 기존 9개 흐름과 새 두 장소의 정·역방향·세 조건 6개 흐름을 검증하고, `.p5-artifacts/p7-demo-places/`에 별도 보고서를 저장합니다.


### P8 경로 비교 설명

P8 작업 브랜치는 `feature/p8-route-explanations`이며 기준은 P7 커밋 `bc98400`입니다. API 계약과 `route.reason`은 그대로 유지합니다. 결과·상세 화면에만 순수 JS 모듈 `app/static/js/route-explanations.js`의 비교 설명을 추가합니다. check 화면과 경로 계산 로직은 변경하지 않습니다.

- 비교 기준은 같은 ID·같은 표시 좌표를 제외한 다른 반환 경로 중 거리 값이 가장 작은 경로입니다. 거리로 정할 수 없으면 첫 비교 후보를 사용합니다. 이는 전체 네트워크의 최단 경로 판정이 아닙니다.
- 비교 대상은 `2번 경로(대안 경로)`처럼 번호와 API 이름으로 명시합니다. `sameRoute:true`여도 별도 대안이 있으면 비교합니다.
- 두 경로 모두 유한한 숫자를 제공한 항목만 뺄셈합니다. 거리·상승·최대 경사 차이는 소수 첫째 자리로 표시하고 반올림 결과가 0이면 생략합니다.
- 계단은 확인된 **구간 수**로 설명합니다. 최대 경사는 확인된 최대값 차이만 `%p`로 표시하며 경로 전체가 더 완만하다고 말하지 않습니다.
- null은 비교에서 제외합니다. 경사 데이터 확인율 100% 미만은 미확인 구간이 있다는 안내를 수치 설명과 별도로 표시합니다. 임의의 낮은 확인율 임계값은 만들지 않습니다.
- 이동 상태 문구는 승인된 `approvedToday`의 true 값과 저장된 프로필 선호만 사용합니다. 검색 조건을 설명할 뿐 실제 편안함이나 접근성 보장이 아닙니다.
- 비교 후보가 없거나 표시할 수치 차이가 없으면 기존 추천 이유와 입력 조건을 안내합니다. 응답·저장된 경로 객체는 변경하지 않습니다.

최신 프론트 `770fed0`을 비교하여 result의 기존 `empty-state`와 `back-link` 두 노드만 상단으로 이동했습니다. HTML 전체·backend·경사 비교 그림은 가져오지 않았습니다.

새 순수 JS 테스트는 Node 기본 테스트 기능을 사용하므로 패키지를 설치하지 않습니다. 테스트 fixture는 설명 함수의 단위 테스트에만 쓰이며 실제 API 성공 응답을 대체하지 않습니다.

```powershell
$naranhiNode = 'C:\Users\kmj00\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $naranhiNode --test .\tests\route_explanations.test.cjs
```

기존 Python 테스트 50개와 Chrome 흐름 15개를 유지하고, 실제 응답 기반 비교 설명·선택 경로 일치·상단 빈 상태 표시를 함께 검증합니다. P8 브라우저 보고서는 `.p5-artifacts/p8-route-explanations/`에 저장합니다.

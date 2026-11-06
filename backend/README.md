# 나란히 백엔드 실행 안내

모든 명령은 VS Code의 PowerShell에서 **저장소 루트 `Hackathon-team8`**를 작업 폴더로 두고 실행합니다. 가상환경의 Python을 직접 호출하므로 활성화 명령이나 PowerShell 실행 정책 변경은 필요하지 않습니다.

## 실행 환경 준비

`backend/.venv`가 이미 있으면 가상환경 생성은 건너뛰고 의존성 설치부터 진행합니다. 다음 경로는 현재 PC에서 확인한 Python 3.12 실행 파일입니다. 다른 PC에서는 사용 가능한 Python 경로로 바꿉니다.

```powershell
$naranhiPython = 'C:\Users\kmj00\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $naranhiPython --version
& $naranhiPython -m venv .\backend\.venv

.\backend\.venv\Scripts\python.exe -m pip install -r .\backend\requirements.txt
.\backend\.venv\Scripts\python.exe -m pip check
```

예상 결과는 Python 버전, 패키지 설치 완료 메시지, `No broken requirements found.`입니다. 가상환경 생성은 정상 완료 시 별도 메시지가 없을 수 있습니다. Python 실행 파일을 찾지 못하면 경로를 먼저 확인하고 시스템 설치나 PATH 변경을 임의로 진행하지 않습니다.

## 서버 시작과 확인

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000
```

정상 기동 시 `Application startup complete`와 `http://127.0.0.1:8000`이 표시됩니다. 이 터미널을 유지하고 두 번째 PowerShell 터미널에서 확인합니다.

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health | ConvertTo-Json -Compress
(Invoke-WebRequest http://127.0.0.1:8000/docs -UseBasicParsing).StatusCode
```

예상 결과는 `{"status":"ok"}`와 `200`입니다. 브라우저에서 <http://127.0.0.1:8000/docs>를 열면 Swagger UI를 사용할 수 있습니다. 서버를 종료할 때는 서버 터미널에서 `Ctrl+C`를 누릅니다. 8000 포트가 사용 중이면 먼저 해당 서버를 확인합니다.

## 경로 요청

`POST /api/routes`는 JSON 요청을 검증한 뒤 A의 `recommend_routes()`를 호출합니다. A의 Python 파일, `nodes.json`, `edges.json`은 현재처럼 같은 `backend/` 폴더에 둡니다.

덕성여대 정문 → 효문중·고 출입구의 요청 예시입니다. 실제 경로 수와 수치는 서버가 계산한 응답을 사용합니다.

```powershell
$requestBody = @{
    start = @{ lat = 37.6517; lng = 127.0149 }
    end = @{ lat = 37.6526; lng = 127.0174 }
    profile = @{ stairs = 'avoid' }
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/routes -ContentType 'application/json' -Body $requestBody
```

Swagger에서는 `POST /api/routes`의 **Try it out**에 같은 요청을 입력하고 **Execute**로 확인할 수 있습니다.

| 요청 필드 | 계약 |
|---|---|
| `start`, `end` | 필수 객체. 각각 숫자 `lat`, `lng` 필요. 위도 −90~90, 경도 −180~180 |
| `profile.stairs` | 필수. `allowed`, `avoid`, `blocked` 중 하나 |
| `profile.detourAllowed`, `gentleSlope`, `comfortFirst` | 선택 Boolean. 기본값 `false` |
| `profile.crosswalks` | 선택. `allowed`, `avoid` 중 하나. 기본값 `allowed` |
| `today` | 선택 객체 또는 `null`. 각 상태의 기본값은 `false` |
| `today`의 상태 | `suitcase`, `tired`, `stroller`, `injuredLeg`, `avoidStairs`, `allowDetour` |
| `clientId` | 선택 문자열 또는 `null`. 서버에 사용자 프로필이나 이력을 저장하지 않음 |

정의되지 않은 요청 필드는 객체의 어느 단계에서든 422 오류로 거부합니다. `today.umbrella`는 지원하지 않습니다. Boolean에는 JSON의 `true`·`false`를 사용하며 문자열 `"true"`나 숫자 `1`로 대신하지 않습니다. 좌표에는 장소명이 아닌 숫자를 전달해야 합니다. 장소명과 시연용 좌표를 연결하는 작업은 프론트 연동 단계에서 준비합니다.

## 응답과 데이터 해석

- 최상위 응답은 `requestId`, `routes`, `sameRoute`, `warnings`를 포함합니다.
- `routes`는 실제로 계산한 서로 다른 경로 1~3개입니다. 없는 두 번째 경로를 만들지 않습니다. 각 경로에는 `id`, `label`, `distanceM`, `ascentM`, `maxSlopePercent`, `gradeCoveragePercent`, `stairsCount`, `crosswalkCount`, `coordinates`, `reason`, `warnings`가 있습니다.
- `sameRoute`는 맞춤 경로와 최단 경로가 같은지를 나타냅니다. `true`여도 실제 대안이 추가되어 여러 경로가 반환될 수 있습니다. 카드 역할은 순서로 추정하지 않고 `id`와 `label`을 사용합니다.
- `gradeCoveragePercent`는 경사 정보가 확인 가능한 구간의 **거리 합 ÷ 전체 경로 거리 × 100**이며 범위는 0~100입니다. 확보율 0%는 평지라는 뜻이 아닙니다.
- `ascentM`, `maxSlopePercent`, `crosswalkCount`는 필드가 존재하면서 값이 `null`일 수 있습니다. 프론트는 이를 0으로 바꾸지 않고 “정보 미확인”으로 표시합니다.
- `coordinates`의 각 좌표는 `[lng, lat]` 순서입니다. 지도 SDK가 다른 순서를 요구하면 프론트에서 변환합니다.
- `durationMin`과 같은 소요시간은 현재 A가 제공하지 않습니다. 시간이나 미확인 지표를 임의로 계산한 값처럼 표시하지 않습니다.
- 경로별 `warnings`와 최상위 `warnings`를 모두 사용자에게 안내합니다. `stairsCount: 0`은 **확인된 계단이 0개**라는 뜻이며 무장애 경로를 보장하지 않습니다.

현재 데이터는 노드 1,030개, 방향별 간선 2,956개입니다. 경사 정보는 80개 간선에만 있으며 90m DEM에 기반한 참고용 추정치입니다. 실제 횡단 횟수와 보도 단차는 미확인입니다. `crosswalks: "avoid"`는 OSM에 횡단 태그가 있는 구간을 회피하는 선호이며 실제 횡단 횟수 감소나 보행 단절 회피를 보장하지 않습니다.

`today.stroller: true` 또는 `profile.stairs: "blocked"`이면 확인된 계단을 최단·맞춤 탐색에서 제외합니다. `detourAllowed: false`는 우회를 완전히 금지하는 뜻이 아닙니다. `comfortFirst`가 `detourAllowed`를 자동으로 켜지 않으며 두 값을 함께 설정할지는 프론트 UI 합의에 따릅니다.

## 오류 응답

오류는 성공 응답과 구분되는 HTTP 상태 및 다음 JSON 구조로 전달합니다. 내부 검증 상세, 위치 목록, 스택 추적은 응답에 포함하지 않습니다.

```json
{"error":{"code":"VALIDATION_ERROR","message":"출발지와 이동 조건을 확인해 주세요."}}
```

| HTTP | `error.code` | 의미 |
|---|---|---|
| 422 | `VALIDATION_ERROR` | 필수값·자료형·좌표 오류, 미지원 필드 또는 같은 보행 노드에 연결된 출발·도착 |
| 404 | `NO_ROUTE` | 조건에 맞는 경로가 없음 |
| 503 | `DATA_UNAVAILABLE` | 보행 데이터 사용 불가 또는 지원 구역 밖의 좌표 |
| 500 | `INTERNAL_ERROR` | 예상하지 못한 서버 내부 오류 |

경사 정보 일부가 미확인이라는 이유만으로 경로 계산을 실패시키지 않습니다. 계산 가능한 경로는 200 응답에 `null`과 경고를 포함합니다.

## 테스트

서버를 별도로 켜지 않아도 지정한 테스트가 임시 포트의 서버로 HTTP 요청을 확인합니다.

```powershell
.\backend\.venv\Scripts\python.exe -B -m unittest discover -s backend/tests -v
```

테스트는 `docs/example_input.json`, `docs/example_output.json`과 실제 A 함수의 결과를 비교합니다. `requestId`는 매 호출마다 생성되므로 비교에서 제외합니다. 테스트 성공 시 마지막에 `OK`가 표시됩니다.

기존 `backend/test_route_service_v02.py`를 직접 실행하면 예시 JSON을 생성하거나 덮어씁니다. 위의 지정 테스트 명령을 사용하고 기존 예시 파일은 테스트 출력으로 덮어쓰지 않습니다.

선택 이력 저장 API는 아직 포함하지 않습니다. P5 통합 worktree에서는 같은 FastAPI 서버가 프론트도 제공하며 별도 CORS나 Flask 서버가 필요하지 않습니다. 프로필은 프론트 localStorage가 저장하며 서버 DB는 사용하지 않습니다. 통합 실행법은 루트 README를 참고합니다.

## 오늘 상태 분석: P4

`POST /api/conditions/parse`는 `{ "text": "..." }` 요청을 받아 규칙으로 상태를 분석합니다. LLM을 호출하지 않습니다. 텍스트는 공백·탭·줄바꿈 등 공백 문자를 모두 제외한 길이가 1~500자여야 합니다. 빈 값, 공백만 있는 값, 초과 길이, 문자열이 아닌 값, 잘못된 JSON과 정의되지 않은 요청 필드는 `422 INVALID_TEXT`로 거부합니다.

```powershell
$conditionBody = @{ text = '캐리어가 있어요. 계단은 피하고 싶어요.' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/conditions/parse -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($conditionBody)) | ConvertTo-Json -Depth 6
```

응답은 `today`, `recognizedTerms`, `warnings`, `requiresConfirmation: true`, `parserMethod: "rules"`를 포함합니다. 위 문장은 `today.suitcase: true`, `today.avoidStairs: true`를 인식합니다. `today`는 인식한 키만 포함하는 부분 객체입니다. 미인식 상태를 전부 false로 채우지 않습니다.

- 허용 상태는 `suitcase`, `stroller`, `injuredLeg`, `tired`, `avoidStairs`, `allowDetour` 여섯 개입니다. 우산 필드는 지원하지 않습니다.
- 캐리어·여행가방, 유모차, 다리 부상·통증·목발, 피곤함, 계단 회피, 우회 허용 표현을 인식합니다. 한 문장의 여러 조건을 결합할 수 있습니다.
- “캐리어 없어요”, “유모차를 안 끌어요”, “다리 안 다쳤어요”, “계단 피할 필요 없어요” 같은 명시적 부정은 해당 상태의 `false`로 반환합니다.
- 인식하지 못하면 `today: {}`와 경고를 담은 200 응답을 반환합니다. 모호하거나 같은 항목의 긍정·부정이 상충하면 그 키를 생략하고 수동 확인 경고를 반환합니다.
- `recognizedTerms`에는 짧은 인식 키워드만 담습니다. 원문을 저장·로그에 기록하거나 전체 문장을 응답에 복사하지 않습니다. 예상하지 못한 분석 오류는 원문·내부 상세 없이 `500 PARSER_FAILED`로 반환합니다.
- 프론트는 항상 확인 화면을 거친 뒤 사용자가 승인한 `today`만 `/api/routes`에 전달해야 합니다. 이 API는 프로필을 수정하거나 경로를 계산하지 않습니다. `avoidStairs: false`도 기존 `profile.stairs: "blocked"`를 해제하지 않습니다.

규칙 기반 분석은 모든 한국어 표현을 이해하지 못합니다. 부정 범위가 복잡하거나 조건이 모호하면 반환된 경고를 보고 직접 상태를 확인해야 합니다.

기존 경로 API 회귀 테스트와 새 파서·HTTP 테스트는 같은 명령으로 실행합니다. 별도 테스트 패키지는 필요하지 않습니다.

```powershell
.\backend\.venv\Scripts\python.exe -B -m unittest discover -s backend/tests -v
```

새 API를 추가한 뒤 기존 서버를 사용 중이었다면 `Ctrl+C`로 종료하고 서버 시작 명령으로 다시 실행합니다.

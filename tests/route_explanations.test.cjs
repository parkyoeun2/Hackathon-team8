"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRouteExplanation: build } = require("../app/static/js/route-explanations.js");

// 순수 함수 입력용 fixture입니다. 서버/API 성공 응답을 대체하지 않습니다.
function route(overrides = {}) {
  return {
    id: "route_1", label: "맞춤 추천", distanceM: 100, stairsCount: 0,
    ascentM: null, maxSlopePercent: null, crosswalkCount: null, gradeCoveragePercent: 20,
    coordinates: [[127, 37], [127.01, 37.01]],
    reason: "A가 반환한 원래 이유입니다.", warnings: [],
    ...overrides,
  };
}
function pair(current = {}, other = {}) {
  return [
    route(current),
    route({ id: "route_2", label: "대안 경로", distanceM: 126.2,
      coordinates: [[127, 37], [127.02, 37.01]], ...other }),
  ];
}
function explain(current = {}, other = {}, context = {}) {
  const routes = pair(current, other);
  return build(routes[0], routes, context);
}

test("거리 차이는 실제 두 값의 차이를 명시한 비교 대상과 표시한다", () => {
  const result = explain();
  assert.equal(result.number, 1);
  assert.deepEqual(result.reference, { id: "route_2", label: "대안 경로", number: 2 });
  assert.ok(result.facts.includes("2번 경로(대안 경로)보다 26.2m 짧아요."));
  assert.equal(result.originalReason, "A가 반환한 원래 이유입니다.");
  assert.equal(result.fallback, null);
});
test("선택 경로가 길면 실제 더 긴 거리도 숨기지 않는다", () => {
  assert.ok(explain({ distanceM: 150 }, { distanceM: 123.8 }).facts
    .includes("2번 경로(대안 경로)보다 26.2m 더 길어요."));
});
test("확인된 계단은 단수가 아닌 구간 개수 차이로 설명한다", () => {
  const result = explain({ stairsCount: 0 }, { stairsCount: 1 });
  assert.ok(result.facts.includes("2번 경로(대안 경로)보다 확인된 계단 구간이 1개 적어요."));
  assert.ok(!result.facts.join(" ").includes("계단이 없"));
});
test("계단 구간이 더 많은 경우도 실제 수치를 설명한다", () => {
  assert.ok(explain({ stairsCount: 3 }, { stairsCount: 1 }).facts
    .some(sentence => sentence.includes("확인된 계단 구간이 2개 많아요")));
});
test("같은 ID 또는 같은 표시 좌표의 경로는 비교 대상에서 제외한다", () => {
  const a = route();
  assert.equal(build(a, [a, { ...a, id: "route_2", distanceM: 150 }]).reference, null);
  assert.equal(build(a, [a, { ...a, coordinates: [[127, 37], [127.03, 37.03]] }]).reference, null);
});
test("실제 다른 경로의 지표가 같으면 같은 경로라고 단정하지 않는다", () => {
  const result = explain({}, { distanceM: 100 });
  assert.notEqual(result.reference, null);
  assert.deepEqual(result.facts, []);
  assert.equal(result.fallback, result.originalReason);
});
test("대안이 없으면 기존 이유를 그대로 사용한다", () => {
  const a = route();
  const result = build(a, [a]);
  assert.equal(result.reference, null);
  assert.deepEqual(result.facts, []);
  assert.equal(result.fallback, a.reason);
  assert.equal(result.originalReason, a.reason);
});
test("누적 상승이 null이면 상승 수치 비교는 생성하지 않는다", () => {
  const result = explain({ ascentM: null }, { ascentM: 10 });
  assert.ok(!result.facts.some(sentence => sentence.includes("상승")));
  assert.ok(result.uncertainties.some(sentence => sentence.includes("누적 상승") && sentence.includes("제외")));
});
test("최대 경사가 null이면 최대 경사 비교는 생성하지 않는다", () => {
  const result = explain({ maxSlopePercent: 3 }, { maxSlopePercent: null });
  assert.ok(!result.facts.some(sentence => sentence.includes("최대 경사")));
  assert.ok(result.uncertainties.some(sentence => sentence.includes("최대 경사") && sentence.includes("제외")));
});
test("횡단 횟수가 null이면 횟수를 임의로 만들지 않는다", () => {
  const result = explain({ crosswalkCount: null }, { crosswalkCount: 2 });
  assert.ok(!result.facts.some(sentence => sentence.includes("횡단")));
});
test("양쪽 상승 수치가 확인되면 실제 차이만 비교한다", () => {
  assert.ok(explain({ ascentM: 7.1 }, { ascentM: 10.5 }).facts
    .some(sentence => sentence.includes("확인된 누적 상승이 3.4m 적어요")));
});
test("최대 경사 비교는 퍼센트포인트 차이로 한정한다", () => {
  const result = explain({ maxSlopePercent: 3.2 }, { maxSlopePercent: 4.4 });
  assert.ok(result.facts.some(sentence => sentence.includes("확인된 최대 경사가 1.2%p 낮아요")));
  assert.ok(!result.facts.some(sentence => /전체|완만/.test(sentence)));
  assert.ok(result.uncertainties.some(sentence => sentence.includes("90m DEM")));
});
test("확인된 횡단 횟수가 모두 있을 때만 실제 차이를 비교한다", () => {
  assert.ok(explain({ crosswalkCount: 1 }, { crosswalkCount: 3 }).facts
    .some(sentence => sentence.includes("확인된 횡단 횟수가 2회 적어요")));
});
test("낮은 경사 확인율은 사실 비교와 별도 불확실성으로 안내한다", () => {
  const result = explain({ gradeCoveragePercent: 19.7, maxSlopePercent: 3 }, { gradeCoveragePercent: 30, maxSlopePercent: 4 });
  assert.ok(result.uncertainties.some(sentence => sentence.includes("19.7%") && sentence.includes("30%")));
  assert.ok(result.uncertainties.some(sentence => sentence.includes("미확인 구간")));
  assert.ok(!JSON.stringify(result).includes("더 완만"));
});
test("99.9%도 임의 기준 없이 미확인 구간으로 안내한다", () => {
  const result = explain({ gradeCoveragePercent: 99.9 }, { gradeCoveragePercent: 100 });
  assert.ok(result.uncertainties.some(sentence => sentence.includes("99.9%")));
});
test("0% 경사 확인율을 0% 경사나 평지로 해석하지 않는다", () => {
  const result = explain({ gradeCoveragePercent: 0 }, { gradeCoveragePercent: 0 });
  assert.ok(result.uncertainties.some(sentence => sentence.includes("이 경로 0%, 비교 경로 0%")));
  assert.ok(!result.facts.some(sentence => /평지|완만/.test(sentence)));
});
test("100%라도 경사 추정값의 실측 아님 안내를 유지한다", () => {
  const result = explain({ gradeCoveragePercent: 100, maxSlopePercent: 3 }, { gradeCoveragePercent: 100, maxSlopePercent: 5 });
  assert.ok(!result.uncertainties.some(sentence => sentence.includes("미확인 구간")));
  assert.ok(result.uncertainties.some(sentence => sentence.includes("실측값이 아니")));
});
test("sameRoute true여도 실제 다른 대안과 비교한다", () => {
  const result = explain({}, {}, { response: { sameRoute: true } });
  assert.notEqual(result.reference, null);
  assert.ok(result.facts.some(sentence => sentence.includes("26.2m 짧아요")));
});
test("세 경로에서는 다른 반환 경로 중 거리 최소 대상을 명시한다", () => {
  const a = route();
  const b = route({ id: "route_2", label: "대안 경로", distanceM: 300, coordinates: [[127, 37], [127.02, 37]] });
  const c = route({ id: "route_3", label: "대안 경로", distanceM: 200, coordinates: [[127, 37], [127.03, 37]] });
  const result = build(a, [a, b, c]);
  assert.deepEqual(result.reference, { id: "route_3", label: "대안 경로", number: 3 });
  assert.ok(result.facts.some(sentence => sentence.startsWith("3번 경로(대안 경로)보다")));
});
test("비교 대상의 거리가 같으면 응답의 원래 순서를 따른다", () => {
  const routes = pair({}, { distanceM: 200 });
  routes.push(route({ id: "route_3", label: "대안 경로", distanceM: 200, coordinates: [[127, 37], [127.04, 37]] }));
  assert.equal(build(routes[0], routes).reference.id, "route_2");
});
test("거리 비교가 불가하면 첫 다른 경로로 나머지 지표를 비교한다", () => {
  const result = explain({ distanceM: undefined, stairsCount: 1 }, { distanceM: null, stairsCount: 2 });
  assert.equal(result.reference.id, "route_2");
  assert.ok(!result.facts.some(sentence => /m 짧|m 더 길/.test(sentence)));
  assert.ok(result.facts.some(sentence => sentence.includes("계단 구간이 1개 적어요")));
});
test("승인한 오늘 상태 true만 검색 조건으로 설명한다", () => {
  const result = explain({}, {}, { approvedToday: { suitcase: true, stroller: false, injuredLeg: true } });
  assert.ok(result.conditions.includes("캐리어 이동 조건으로 검색했어요."));
  assert.ok(result.conditions.includes("다리 부상·통증 조건으로 검색했어요."));
  assert.ok(!result.conditions.some(sentence => sentence.includes("유모차")));
  assert.ok(!result.conditions.some(sentence => /더 편|더 안전|무장애/.test(sentence)));
});
test("승인하지 않은 today나 자연어 원문은 조건 설명에 사용하지 않는다", () => {
  const result = explain({}, {}, { today: { suitcase: true }, text: "PRIVATE_RAW_TEXT" });
  assert.deepEqual(result.conditions, []);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_RAW_TEXT"));
});
test("프로필 선호는 요청 사실로 표현하며 오늘 상태가 차단을 해제하지 않는다", () => {
  const result = explain({}, {}, { profile: { stairs: "blocked", gentleSlope: true, crosswalks: "avoid",
    comfortFirst: true, detourAllowed: true }, approvedToday: { avoidStairs: false, allowDetour: true } });
  assert.ok(result.conditions.includes("확인된 계단 구간을 제외하는 조건으로 검색했어요."));
  assert.ok(result.conditions.includes("급경사 회피 선호를 반영했어요."));
  assert.ok(result.conditions.includes("횡단 구간 회피 선호로 검색했어요."));
  assert.equal(result.conditions.filter(sentence => sentence === "우회 허용 조건으로 검색했어요.").length, 1);
});
test("0은 유효한 실제 수치로 비교한다", () => {
  const result = explain({ distanceM: 0, ascentM: 0, maxSlopePercent: 0, crosswalkCount: 0 },
    { distanceM: 1, ascentM: 1, maxSlopePercent: 1, crosswalkCount: 1 });
  assert.equal(result.facts.length, 4);
  assert.ok(result.facts.some(sentence => sentence.includes("1m 짧아요")));
});
test("반올림 0과 부동소수점 오차는 이점으로 출력하지 않는다", () => {
  const result = explain({ distanceM: 100.01 }, { distanceM: 100 });
  assert.deepEqual(result.facts, []);
  assert.equal(result.fallback, result.originalReason);
  assert.deepEqual(explain({ distanceM: 0.1 + 0.2 }, { distanceM: 0.3 }).facts, []);
});
for (const invalid of [undefined, null, NaN, Infinity, -1, "100"]) {
  test("유한한 비음수 숫자가 아닌 거리는 비교 제외: " + String(invalid), () => {
    const result = explain({ distanceM: invalid });
    assert.ok(!result.facts.some(sentence => /m 짧|m 더 길/.test(sentence)));
  });
}
test("계단·횡단 개수에 소수를 허용하지 않는다", () => {
  const result = explain({ stairsCount: 1.5, crosswalkCount: 1.5 }, { stairsCount: 3, crosswalkCount: 3 });
  assert.ok(!result.facts.some(sentence => /계단|횡단/.test(sentence)));
});
test("낮은 최대 경사와 높은 누적 상승을 각 지표별 실제 방향으로 표현한다", () => {
  const result = explain({ maxSlopePercent: 6, ascentM: 15 }, { maxSlopePercent: 4, ascentM: 10 });
  assert.ok(result.facts.some(sentence => sentence.includes("최대 경사가 2%p 높아요")));
  assert.ok(result.facts.some(sentence => sentence.includes("누적 상승이 5m 많아요")));
});
test("동일 표시 좌표를 제외해도 별도의 세 번째 대안은 비교한다", () => {
  const a = route();
  const b = { ...a, id: "route_2" };
  const c = route({ id: "route_3", label: "대안 경로", distanceM: 150, coordinates: [[127, 37], [127.05, 37]] });
  assert.equal(build(a, [a, b, c]).reference.id, "route_3");
});
test("입력 응답·조건과 기존 reason을 변경하지 않는다", () => {
  const routes = pair();
  const context = { approvedToday: { suitcase: true }, profile: { stairs: "avoid" }, response: { sameRoute: true, routes } };
  const snapshot = JSON.stringify({ routes, context });
  function freeze(value) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(routes);
  freeze(context);
  const result = build(routes[0], routes, context);
  assert.equal(JSON.stringify({ routes, context }), snapshot);
  assert.equal(result.originalReason, routes[0].reason);
});

// P8 마무리: 기존 비교 계산 36개를 유지하고 화면용 표현만 검증합니다.
const { buildRoutePresentation: present } = require("../app/static/js/route-explanations.js");

test("화면용 모델은 활성 조건이 없으면 기본 검색 배지와 빈 키워드를 제공한다", () => {
  const routes = pair();
  const result = present(routes[0], routes, { profile: { stairs: "allowed", gentleSlope: false,
    crosswalks: "allowed", comfortFirst: false, detourAllowed: false } });
  assert.deepEqual(result.keywords, []);
  assert.equal(result.badge, "기본 조건 검색");
  assert.equal(result.summary, "추가 이동 조건 없이 검색했어요.");
  assert.equal(result.slope, null);
});
test("승인된 true 조건만 키워드로 만들고 false와 원문·미지원 상태는 제외한다", () => {
  const routes = pair();
  const result = present(routes[0], routes, { today: { stroller: true },
    text: "PRIVATE_RAW_TEXT", approvedToday: { suitcase: true, injuredLeg: true,
      stroller: false, tired: "true", umbrella: true } });
  assert.deepEqual(result.keywords, [
    { key: "suitcase", label: "캐리어" }, { key: "injuredLeg", label: "다리 부상" },
  ]);
  assert.equal(result.badge, "이동 조건 검색");
  assert.equal(result.summary, "선택한 이동 조건으로 검색했어요.");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_RAW_TEXT"));
});
test("모든 명시적 이동 조건의 키워드는 정확한 이름과 순서로 표시한다", () => {
  const routes = pair();
  const result = present(routes[0], routes, { approvedToday: {
    suitcase: true, stroller: true, injuredLeg: true, tired: true, avoidStairs: true, allowDetour: true,
  }, profile: { stairs: "avoid", gentleSlope: true, crosswalks: "avoid",
    comfortFirst: true, detourAllowed: true } });
  assert.deepEqual(result.keywords.map(({ label }) => label),
    ["캐리어", "유모차", "다리 부상", "피곤함", "계단 회피", "급경사 회피",
      "횡단 구간 회피", "편안한 길 우선", "우회 허용"]);
  assert.equal(new Set(result.keywords.map(({ key }) => key)).size, result.keywords.length);
});
test("계단 차단 프로필은 오늘의 false나 회피 조건으로 완화되지 않는다", () => {
  const routes = pair();
  for (const avoidStairs of [false, true]) {
    const result = present(routes[0], routes, { profile: { stairs: "blocked" },
      approvedToday: { avoidStairs } });
    assert.deepEqual(result.keywords, [{ key: "stairs", label: "확인된 계단 제외" }]);
  }
});
test("프로필이 허용이어도 승인한 계단 회피 true는 키워드에 반영한다", () => {
  const routes = pair();
  assert.deepEqual(present(routes[0], routes, { profile: { stairs: "allowed" },
    approvedToday: { avoidStairs: true } }).keywords, [{ key: "stairs", label: "계단 회피" }]);
});
test("급경사 회피를 선택하지 않으면 데이터가 부족해도 경사 선호 문구가 없다", () => {
  const routes = pair({ gradeCoveragePercent: 0 });
  const result = present(routes[0], routes, { profile: { gentleSlope: false, comfortFirst: true },
    approvedToday: { stroller: true, gentleSlope: true } });
  assert.equal(result.slope, null);
  assert.ok(!result.keywords.some(({ key }) => key === "gentleSlope"));
});
test("급경사 회피를 선택하고 데이터가 부족하면 선호와 불확실성을 함께 제공한다", () => {
  const routes = pair();
  const result = present(routes[0], routes, { profile: { gentleSlope: true } });
  assert.deepEqual(result.slope, { summary: "급경사 회피 선호를 반영했어요.",
    caution: "실제로 더 완만한지는 확인되지 않았어요." });
  assert.ok(result.keywords.some(({ key }) => key === "gentleSlope"));
});
test("확인율 100%와 숫자 지표가 있어도 검색 선호만 설명하고 더 완만하다고 단정하지 않는다", () => {
  const full = { gradeCoveragePercent: 100, ascentM: 0, maxSlopePercent: 0, crosswalkCount: 0 };
  const routes = pair(full, full);
  const result = present(routes[0], routes, { profile: { gentleSlope: true } });
  assert.equal(result.slope.summary, "급경사 회피 선호를 반영했어요.");
  assert.equal(result.slope.caution, null);
  assert.ok(!result.dataNotes.some((text) => text.includes("확인되지 않은 구간")));
  assert.ok(result.dataNotes.includes("경사 정보는 90m DEM 기반 추정치예요."));
});
test("선택 경로가 완전해도 비교 경로의 경사 정보가 부족하면 주의 문구를 유지한다", () => {
  const routes = pair({ gradeCoveragePercent: 100, ascentM: 1, maxSlopePercent: 2, crosswalkCount: 0 },
    { gradeCoveragePercent: 19.7 });
  const result = present(routes[0], routes, { profile: { gentleSlope: true } });
  assert.equal(result.slope.caution, "실제로 더 완만한지는 확인되지 않았어요.");
  assert.ok(result.dataNotes.includes("비교 경로에 미확인 정보가 있어요."));
  assert.ok(!result.dataNotes.join(" ").includes("19.7%"));
});
test("확인율이 100%여도 선택 경로의 상승·최대 경사 null은 경사 확인으로 바뀌지 않는다", () => {
  const routes = pair({ gradeCoveragePercent: 100, ascentM: null, maxSlopePercent: null },
    { gradeCoveragePercent: 100, ascentM: 1, maxSlopePercent: 2 });
  const result = present(routes[0], routes, { profile: { gentleSlope: true } });
  assert.equal(result.slope.caution, "실제로 더 완만한지는 확인되지 않았어요.");
  assert.ok(!result.displayFacts.some((text) => /최대 경사|누적 상승/.test(text)));
  assert.ok(result.dataNotes.some((text) => /누적 상승.*최대 경사.*미확인/.test(text)));
});
test("하단 데이터 안내의 백분율은 현재 경로 값만 사용한다", () => {
  const routes = pair({ gradeCoveragePercent: 19.7 }, { gradeCoveragePercent: 35.6 });
  const result = present(routes[0], routes, {});
  assert.equal(result.dataNotes[0], "경사 확인율 19.7%.");
  assert.ok(!result.dataNotes.join(" ").includes("35.6%"));
  assert.ok(result.dataNotes.includes("확인되지 않은 구간이 있어요."));
});
test("0% 확인율은 실제 경사 0이나 평지가 아닌 확인율로 표시한다", () => {
  const routes = pair({ gradeCoveragePercent: 0 });
  const result = present(routes[0], routes, { profile: { gentleSlope: true } });
  assert.equal(result.dataNotes[0], "경사 확인율 0%.");
  assert.ok(result.dataNotes.includes("확인되지 않은 구간이 있어요."));
  assert.ok(!result.dataNotes.some((text) => /0% 경사|평지/.test(text)));
  assert.ok(result.slope.caution);
});
test("미확인 확인율을 0%로 바꾸지 않는다", () => {
  const routes = pair({ gradeCoveragePercent: null });
  const result = present(routes[0], routes, {});
  assert.equal(result.dataNotes[0], "경사 확인율 미확인.");
  assert.ok(!result.dataNotes.join(" ").includes("0%"));
});
test("우회 허용은 중복하지 않고 편안함 우선에서 임의 추론하지 않는다", () => {
  const routes = pair();
  const merged = present(routes[0], routes, { profile: { detourAllowed: true },
    approvedToday: { allowDetour: true } });
  assert.deepEqual(merged.keywords, [{ key: "allowDetour", label: "우회 허용" }]);
  const comfort = present(routes[0], routes, { profile: { comfortFirst: true, detourAllowed: false } });
  assert.deepEqual(comfort.keywords, [{ key: "comfortFirst", label: "편안한 길 우선" }]);
});
test("핵심 비교 문장은 비교 대상 이름만 줄이고 수치와 기존 사실 문장을 보존한다", () => {
  const routes = pair();
  const original = build(routes[0], routes);
  const result = present(routes[0], routes);
  assert.deepEqual(result.displayFacts, ["2번 경로보다 26.2m 짧아요."]);
  assert.deepEqual(result.facts, original.facts);
  assert.equal(result.originalReason, routes[0].reason);
  assert.equal(original.facts[0], "2번 경로(대안 경로)보다 26.2m 짧아요.");
});
test("선택 경로가 달라지면 해당 번호·확인율·비교 방향을 사용한다", () => {
  const routes = pair({ gradeCoveragePercent: 19.7 }, { gradeCoveragePercent: 35.6 });
  const result = present(routes[1], routes, { response: { sameRoute: true } });
  assert.equal(result.number, 2);
  assert.equal(result.reference.number, 1);
  assert.equal(result.dataNotes[0], "경사 확인율 35.6%.");
  assert.deepEqual(result.displayFacts, ["1번 경로보다 26.2m 더 길어요."]);
});
test("비교 후보가 없는 화면용 모델도 기존 reason과 활성 조건을 유지한다", () => {
  const only = route();
  const result = present(only, [only], { approvedToday: { suitcase: true } });
  assert.deepEqual(result.displayFacts, []);
  assert.equal(result.fallback, only.reason);
  assert.equal(result.originalReason, only.reason);
  assert.deepEqual(result.keywords, [{ key: "suitcase", label: "캐리어" }]);
});
test("화면용 모델 생성이 기존 비교 결과와 모든 입력을 변경하지 않는다", () => {
  const routes = pair(), context = { approvedToday: { suitcase: true }, profile: { gentleSlope: true } };
  const snapshot = JSON.stringify({ routes, context });
  const original = build(routes[0], routes, context);
  function freeze(value) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(routes);
  freeze(context);
  const result = present(routes[0], routes, context);
  for (const key of ["number", "reference", "facts", "conditions", "uncertainties", "fallback", "originalReason"])
    assert.deepEqual(result[key], original[key]);
  assert.equal(JSON.stringify({ routes, context }), snapshot);
});

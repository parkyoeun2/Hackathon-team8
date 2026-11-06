/* 실제 API 응답을 바꾸지 않고 화면용 비교 설명만 생성합니다. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NaranhiRouteExplanations = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const formatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const numeric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const count = (value) => numeric(value) && Number.isInteger(value);
  const coverage = (value) => numeric(value) && value <= 100;
  const format = (value) => formatter.format(value);
  const roundDifference = (value) => Math.round((Math.abs(value) + Number.EPSILON) * 10) / 10;

  function sameDisplayedGeometry(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length < 2 || left.length !== right.length) return false;
    return left.every((point, index) => Array.isArray(point) && point.length === 2
      && Array.isArray(right[index]) && right[index].length === 2
      && point[0] === right[index][0] && point[1] === right[index][1]);
  }

  function conditionsFor(context) {
    const today = object(context.approvedToday) ? context.approvedToday : {};
    const profile = object(context.profile) ? context.profile : {};
    const conditions = [];
    [
      ["suitcase", "캐리어 이동 조건으로 검색했어요."],
      ["stroller", "유모차 이동 조건으로 검색했어요."],
      ["injuredLeg", "다리 부상·통증 조건으로 검색했어요."],
      ["tired", "피곤함을 오늘 상태로 적용해 검색했어요."],
    ].forEach(([key, sentence]) => { if (today[key] === true) conditions.push(sentence); });
    if (profile.stairs === "blocked") conditions.push("확인된 계단 구간을 제외하는 조건으로 검색했어요.");
    else if (profile.stairs === "avoid" || today.avoidStairs === true) conditions.push("계단 회피 조건으로 검색했어요.");
    if (profile.gentleSlope === true) conditions.push("급경사 회피 선호를 반영했어요.");
    if (profile.crosswalks === "avoid") conditions.push("횡단 구간 회피 선호로 검색했어요.");
    if (profile.comfortFirst === true) conditions.push("편안한 길 우선 선호로 검색했어요.");
    if (profile.detourAllowed === true || today.allowDetour === true) conditions.push("우회 허용 조건으로 검색했어요.");
    return conditions;
  }

  function buildRouteExplanation(route, routes, context) {
    const current = object(route) ? route : {};
    const list = Array.isArray(routes) ? routes : [];
    const requestContext = object(context) ? context : {};
    const currentIndex = list.findIndex((item) => item === current
      || (typeof current.id === "string" && object(item) && item.id === current.id));
    const candidates = list.map((item, index) => ({ route: item, number: index + 1 }))
      .filter((item) => object(item.route) && typeof item.route.id === "string"
        && item.route !== current && item.route.id !== current.id
        && !sameDisplayedGeometry(current.coordinates, item.route.coordinates));
    // 최단이라는 새 역할을 붙이지 않습니다. 실제 반환된 다른 경로 하나를
    // 거리 오름차순, 동률이면 원래 응답 순서로 골라 비교 대상을 명시합니다.
    let chosen = null;
    candidates.forEach((candidate) => {
      if (chosen === null || (numeric(candidate.route.distanceM)
        && (!numeric(chosen.route.distanceM) || candidate.route.distanceM < chosen.route.distanceM))) chosen = candidate;
    });
    const reference = chosen ? {
      id: chosen.route.id,
      label: typeof chosen.route.label === "string" ? chosen.route.label : "",
      number: chosen.number,
    } : null;
    const other = chosen ? chosen.route : null;
    const prefix = reference ? reference.number + "번 경로" + (reference.label ? "(" + reference.label + ")" : "") + "보다 " : "";
    const facts = [];
    const missing = [];
    if (other) {
      [
        ["distanceM", "거리", numeric, "", "m 짧아요.", "m 더 길어요."],
        ["stairsCount", "확인된 계단 구간 수", count, "확인된 계단 구간이 ", "개 적어요.", "개 많아요."],
        ["ascentM", "누적 상승", numeric, "확인된 누적 상승이 ", "m 적어요.", "m 많아요."],
        ["maxSlopePercent", "최대 경사", numeric, "확인된 최대 경사가 ", "%p 낮아요.", "%p 높아요."],
        ["crosswalkCount", "횡단 횟수", count, "확인된 횡단 횟수가 ", "회 적어요.", "회 많아요."],
      ].forEach(([field, label, valid, noun, lower, higher]) => {
        if (!valid(current[field]) || !valid(other[field])) {
          missing.push(label);
          return;
        }
        const difference = current[field] - other[field];
        const displayed = roundDifference(difference);
        if (displayed === 0) return;
        facts.push(prefix + noun + format(displayed) + (difference < 0 ? lower : higher));
      });
    }
    const uncertainties = [];
    if (coverage(current.gradeCoveragePercent) && current.gradeCoveragePercent < 100
      || other && coverage(other.gradeCoveragePercent) && other.gradeCoveragePercent < 100) {
      let sentence = "경사 데이터 확인율은 ";
      sentence += coverage(current.gradeCoveragePercent) ? "이 경로 " + format(current.gradeCoveragePercent) + "%" : "이 경로 미확인";
      if (other) sentence += coverage(other.gradeCoveragePercent) ? ", 비교 경로 " + format(other.gradeCoveragePercent) + "%" : ", 비교 경로 미확인";
      uncertainties.push(sentence + "예요. 미확인 구간은 경사가 없다는 뜻이 아니에요.");
    } else if (!coverage(current.gradeCoveragePercent) || other && !coverage(other.gradeCoveragePercent)) {
      uncertainties.push("경사 데이터 확인율이 미확인이어서 경로 전체의 경사를 판단하지 않아요.");
    }
    if ((coverage(current.gradeCoveragePercent) && current.gradeCoveragePercent > 0)
      || (other && coverage(other.gradeCoveragePercent) && other.gradeCoveragePercent > 0)
      || numeric(current.ascentM) || numeric(current.maxSlopePercent)
      || other && (numeric(other.ascentM) || numeric(other.maxSlopePercent))) {
      uncertainties.push("경사·상승 수치는 90m DEM 기반 참고용 추정값이며 실측값이 아니에요.");
    }
    if (missing.length) uncertainties.push(missing.join("·") + " 항목은 비교할 수 있는 값이 없어 수치 비교에서 제외했어요.");
    const originalReason = typeof current.reason === "string" ? current.reason : "";
    return {
      number: currentIndex >= 0 ? currentIndex + 1 : null,
      reference,
      facts,
      conditions: conditionsFor(requestContext),
      uncertainties,
      fallback: (!reference || facts.length === 0) && originalReason ? originalReason : null,
      originalReason,
    };
  }

  // 기존 비교 계산은 그대로 사용하고, 읽기 쉬운 화면용 정보만 더합니다.
  function buildRoutePresentation(route, routes, context) {
    const explanation = buildRouteExplanation(route, routes, context);
    const current = object(route) ? route : {};
    const requestContext = object(context) ? context : {};
    const profile = object(requestContext.profile) ? requestContext.profile : {};
    const today = object(requestContext.approvedToday) ? requestContext.approvedToday : {};
    const list = Array.isArray(routes) ? routes : [];
    const other = explanation.reference
      ? list.find((item) => object(item) && item.id === explanation.reference.id) : null;
    const keywords = [];
    const add = (key, label) => keywords.push({ key, label });
    [
      ["suitcase", "캐리어"],
      ["stroller", "유모차"],
      ["injuredLeg", "다리 부상"],
      ["tired", "피곤함"],
    ].forEach(([key, label]) => { if (today[key] === true) add(key, label); });
    if (profile.stairs === "blocked") add("stairs", "확인된 계단 제외");
    else if (profile.stairs === "avoid" || today.avoidStairs === true) add("stairs", "계단 회피");
    if (profile.gentleSlope === true) add("gentleSlope", "급경사 회피");
    if (profile.crosswalks === "avoid") add("crosswalks", "횡단 구간 회피");
    if (profile.comfortFirst === true) add("comfortFirst", "편안한 길 우선");
    if (profile.detourAllowed === true || today.allowDetour === true) add("allowDetour", "우회 허용");

    const reference = explanation.reference;
    const originalPrefix = reference ? reference.number + "번 경로"
      + (reference.label ? "(" + reference.label + ")" : "") + "보다 " : "";
    const compactPrefix = reference ? reference.number + "번 경로보다 " : "";
    const displayFacts = explanation.facts.map((sentence) =>
      originalPrefix && sentence.startsWith(originalPrefix)
        ? compactPrefix + sentence.slice(originalPrefix.length) : sentence);

    const slopeIncomplete = (item) => !coverage(item.gradeCoveragePercent)
      || item.gradeCoveragePercent < 100 || !numeric(item.ascentM) || !numeric(item.maxSlopePercent);
    const slope = profile.gentleSlope === true ? {
      summary: "급경사 회피 선호를 반영했어요.",
      caution: slopeIncomplete(current) || other && slopeIncomplete(other)
        ? "실제로 더 완만한지는 확인되지 않았어요." : null,
    } : null;

    const dataNotes = [
      coverage(current.gradeCoveragePercent)
        ? "경사 확인율 " + format(current.gradeCoveragePercent) + "%." : "경사 확인율 미확인.",
      "경사 정보는 90m DEM 기반 추정치예요.",
    ];
    if (coverage(current.gradeCoveragePercent) && current.gradeCoveragePercent < 100)
      dataNotes.push("확인되지 않은 구간이 있어요.");
    else if (!coverage(current.gradeCoveragePercent))
      dataNotes.push("경사 데이터가 충분한지는 확인되지 않았어요.");
    const fields = [
      ["ascentM", "누적 상승", numeric],
      ["maxSlopePercent", "최대 경사", numeric],
      ["crosswalkCount", "횡단 횟수", count],
    ];
    const missing = fields.filter(([key, , valid]) => !valid(current[key])).map(([, label]) => label);
    if (missing.length) dataNotes.push(missing.join("·") + " 정보는 미확인이에요.");
    if (other && ((coverage(current.gradeCoveragePercent) && current.gradeCoveragePercent === 100
      && (!coverage(other.gradeCoveragePercent) || other.gradeCoveragePercent < 100))
      || fields.some(([key, , valid]) => valid(current[key]) && !valid(other[key])))) {
      dataNotes.push("비교 경로에 미확인 정보가 있어요.");
    }

    return {
      ...explanation,
      displayFacts,
      badge: keywords.length ? "이동 조건 검색" : "기본 조건 검색",
      summary: keywords.length ? "선택한 이동 조건으로 검색했어요." : "추가 이동 조건 없이 검색했어요.",
      keywords,
      slope,
      dataNotes,
    };
  }

  return Object.freeze({ buildRouteExplanation, buildRoutePresentation });
});

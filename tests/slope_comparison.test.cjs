const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app/static/js/script.js"), "utf8");
const segments = JSON.parse(fs.readFileSync(
  path.join(root, "app/static/data/known-slope-segments.json"), "utf8"
));
const edges = JSON.parse(fs.readFileSync(path.join(root, "backend/edges.json"), "utf8"));

function loadHelpers(fetcher = async () => ({ ok: true, json: async () => segments })) {
  // 기존 앱 코드를 수정하거나 브라우저를 띄우지 않고 내부 함수만 검사합니다.
  const injected = source.replace(/\}\)\(\);\s*$/,
    "window.__slopeTests={confirmedSlope,slopeSegmentKey,renderSlopeComparison};})();");
  assert.notEqual(injected, source, "앱 함수 노출용 테스트 지점을 찾지 못했습니다.");
  const fakeWindow = {};
  const fakeDocument = {
    addEventListener() {},
    createElementNS(_ns, tag) {
      return {
        tag, attributes: {},
        setAttribute(key, value) { this.attributes[key] = value; },
      };
    },
  };
  vm.runInNewContext(injected, {
    window: fakeWindow, document: fakeDocument, Intl, fetch: fetcher, console,
  });
  return fakeWindow.__slopeTests;
}

const parsePair = (key) => key.split("|").map(
  (part) => part.split(",").map(Number)
);
const entries = Object.entries(segments);

test("경사 인덱스의 모든 293개 좌표 구간과 값이 원본 edges.json에 일치한다", () => {
  const { slopeSegmentKey } = loadHelpers();
  const fromEdges = new Map();
  for (const edge of edges) {
    const grade = edge.maxAbsGradePct;
    if (typeof grade !== "number" || !Number.isFinite(grade) || grade < 0) continue;
    for (let i = 1; i < edge.geometry.length; i += 1) {
      const key = slopeSegmentKey(edge.geometry[i - 1], edge.geometry[i]);
      assert.ok(!fromEdges.has(key) || fromEdges.get(key) === grade,
        `충돌하는 간선 경사값: ${key}`);
      fromEdges.set(key, grade);
    }
  }
  assert.equal(entries.length, 293);
  assert.equal(fromEdges.size, entries.length);
  for (const [key, value] of entries) assert.equal(fromEdges.get(key), value);
});

test("양방향 좌표를 같은 구간으로 판단한다", () => {
  const { slopeSegmentKey } = loadHelpers();
  const [a, b] = parsePair(entries[0][0]);
  assert.equal(slopeSegmentKey(a, b), slopeSegmentKey(b, a));
});

test("미확인 구간은 null, 실제 경사 0은 숫자 0으로 처리한다", () => {
  const { confirmedSlope, slopeSegmentKey } = loadHelpers();
  const [a, b] = parsePair(entries[0][0]);
  const path = { coordinates: [a, b] };
  const normalize = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(normalize(confirmedSlope(path, {})), { maximum: null, matched: 0 });
  assert.deepEqual(normalize(confirmedSlope(path, {
    [slopeSegmentKey(a, b)]: 0,
  })), { maximum: 0, matched: 1 });
});

test("같은 경로와 급경사 회피 미선택에서는 그래프를 표시하지 않는다", async () => {
  const { renderSlopeComparison } = loadHelpers();
  const [a, b] = parsePair(entries[0][0]);
  const route = { id: "same", distanceM: 30, coordinates: [a, b] };
  const figure = { hidden: false };
  await renderSlopeComparison({
    profile: { gentleSlope: true }, response: { routes: [route] },
  }, route, figure);
  assert.equal(figure.hidden, true);
  figure.hidden = false;
  await renderSlopeComparison({
    profile: { gentleSlope: false }, response: { routes: [route] },
  }, route, figure);
  assert.equal(figure.hidden, true);
});

test("서로 다른 유효 경로 두 개일 때만 경사 비교 그림을 생성한다", async () => {
  const { renderSlopeComparison } = loadHelpers();
  const [a, b] = parsePair(entries[0][0]);
  const [c, d] = parsePair(entries.find((entry) => entry[1] !== entries[0][1])[0]);
  const shortest = { id: "shortest", distanceM: 10, coordinates: [a, b] };
  const chosen = { id: "chosen", distanceM: 20, coordinates: [c, d] };
  const chart = {
    attributes: {}, children: [],
    replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); },
    setAttribute(key, value) { this.attributes[key] = value; },
  };
  const note = { textContent: "" };
  const figure = {
    hidden: true,
    querySelector(selector) {
      return selector === "#slope-comparison-chart" ? chart : note;
    },
  };
  await renderSlopeComparison({
    profile: { gentleSlope: true }, response: { routes: [shortest, chosen] },
  }, chosen, figure);
  assert.equal(figure.hidden, false);
  assert.equal(chart.children.length, 3);
  assert.equal(chart.children[1].attributes["stroke-dasharray"], undefined,
    "선택한 길은 실선이어야 합니다.");
  assert.equal(chart.children[2].attributes["stroke-dasharray"], "7 5",
    "최단거리 경로는 점선이어야 합니다.");
  // 실선·점선 높이의 순서는 실제 경사 수치가 결정합니다.
  const topY = (child) => Number(child.attributes.points.split(" ")[2].split(",")[1]);
  const selectedY = topY(chart.children[1]);
  const shortestY = topY(chart.children[2]);
  assert.equal(
    Math.sign(shortestY - selectedY),
    Math.sign(entries.find((entry) => entry[1] !== entries[0][1])[1] - entries[0][1]),
    "선 높이는 선택한 길과 최단거리의 경사값을 그대로 반영해야 합니다."
  );
  assert.match(note.textContent, /90m DEM 기반 추정값/);
  assert.match(chart.attributes["aria-label"], /최대 경사/);
});

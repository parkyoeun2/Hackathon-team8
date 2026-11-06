// Isolated real-browser integration checks. Successful API and Leaflet responses are never mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.NARANHI_PLAYWRIGHT_MODULE || 'playwright');

const base = process.env.NARANHI_TEST_URL || 'http://127.0.0.1:8001';
const artifacts = path.resolve(process.env.NARANHI_TEST_ARTIFACTS || '.p5-artifacts/p8-readability');
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const TILE_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_URL = /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/;
const PROFILE = 'naranhi.profile.v1';
const TRIP = 'naranhi.trip.v1';
const rawText = '캐리어가 있어요. 계단은 피하고 싶어요.';
const profile = { stairs: 'avoid', detourAllowed: true, gentleSlope: true,
  crosswalks: 'allowed', comfortFirst: true };
const completed = [];
const p7Cases = [];
const p8Examples = [];
const readabilityExamples = [];
const errors = [];
const externalRequests = [];
const requests = [];
const networkResponses = [];
const networkFailures = [];
const contexts = new Set();

async function shot(page, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    name + ': horizontal overflow');
  await page.screenshot({ path: path.join(artifacts, name + '.png'), fullPage: true });
}

async function selectPlaces(page) {
  await page.locator('#start option[value="duksung_gate"]').waitFor({ state: 'attached' });
  await page.selectOption('#start', 'duksung_gate');
  await page.selectOption('#end', 'hyomun_gate');
}

function apiResponse(page, endpoint) {
  return page.waitForResponse(response =>
    response.url() === base + endpoint && response.request().method() === 'POST');
}

function externalAllowed(url) {
  return url === LEAFLET_JS || url === LEAFLET_CSS || TILE_URL.test(url);
}

async function observedContext(browser, label, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: options.hasTouch === true });
  contexts.add(context);
  context.setDefaultTimeout(15000);
  context.on('page', page => page.on('pageerror', error => errors.push({ case: label, message: error.message })));
  context.on('request', request => {
    const url = request.url();
    if (url.startsWith('http') && !url.startsWith(base + '/'))
      externalRequests.push({ case: label, url });
    if (request.method() === 'POST' && url.startsWith(base + '/api/'))
      requests.push({ case: label, url, body: request.postDataJSON() });
  });
  context.on('response', response => {
    const url = response.url();
    if (externalAllowed(url))
      networkResponses.push({ case: label, url, status: response.status() });
  });
  context.on('requestfailed', request => {
    const url = request.url();
    networkFailures.push({ case: label, url, error: request.failure()?.errorText || '',
      intentional: Boolean(options.abortLibrary && url === LEAFLET_JS)
        || Boolean(options.abortTiles && TILE_URL.test(url)) });
  });
  // Runs before the app's DOMContentLoaded listener. Wrappers delegate to the
  // real Leaflet factories and keep the real returned layers for assertions.
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      if (!window.L) return;
      const audit = window.__p6MapAudit = { lines: [], markers: [], tiles: [] };
      [['polyline', 'lines'], ['circleMarker', 'markers'], ['tileLayer', 'tiles']].forEach(([name, key]) => {
        const original = window.L[name];
        window.L[name] = function (...args) {
          const layer = original.apply(this, args);
          audit[key].push({ layer, firstArgument: args[0] });
          return layer;
        };
      });
    }, { once: true });
  });
  if (options.trip) {
    await context.addInitScript(({ profileKey, tripKey, savedProfile, savedTrip, expectedOrigin }) => {
      if (location.origin !== expectedOrigin) return;
      localStorage.setItem(profileKey, JSON.stringify(savedProfile));
      sessionStorage.setItem(tripKey, JSON.stringify(savedTrip));
    }, { profileKey: PROFILE, tripKey: TRIP, savedProfile: profile, savedTrip: options.trip,
      expectedOrigin: new URL(base).origin });
  }
  if (options.abortLibrary) await context.route(LEAFLET_JS, route => route.abort('failed'));
  if (options.abortTiles) await context.route(TILE_URL, route => route.abort('failed'));
  return context;
}

async function closeContext(context) {
  contexts.delete(context);
  await context.close();
}

async function preparedHome(browser, label, savedProfile = profile, options = {}) {
  const context = await observedContext(browser, label, options);
  await context.addInitScript(({ key, value, expectedOrigin }) => {
    if (location.origin === expectedOrigin) localStorage.setItem(key, JSON.stringify(value));
  }, { key: PROFILE, value: savedProfile, expectedOrigin: new URL(base).origin });
  const page = await context.newPage();
  await page.goto(base + '/home.html');
  await selectPlaces(page);
  return { context, page };
}

async function waitForRoute(page, id) {
  await page.waitForURL(url => url.pathname === '/route.html' && url.searchParams.get('routeId') === id);
}

function expectedKeywordKeys(trip) {
  const today = trip.approvedToday || {}, preferences = trip.profile || {};
  const keys = ['suitcase', 'stroller', 'injuredLeg', 'tired'].filter(key => today[key] === true);
  if (preferences.stairs === 'blocked' || preferences.stairs === 'avoid' || today.avoidStairs === true) keys.push('stairs');
  if (preferences.gentleSlope === true) keys.push('gentleSlope');
  if (preferences.crosswalks === 'avoid') keys.push('crosswalks');
  if (preferences.comfortFirst === true) keys.push('comfortFirst');
  if (preferences.detourAllowed === true || today.allowDetour === true) keys.push('allowDetour');
  return keys;
}

async function assertReadableCard(card, route) {
  const box = card.locator('.route-explanations');
  const trip = await card.evaluate(() => JSON.parse(sessionStorage.getItem('naranhi.trip.v1')));
  const expectedKeys = expectedKeywordKeys(trip);
  const keywordContainer = box.locator('.explanation-conditions');
  const actualKeys = await keywordContainer.locator('.condition-keyword').evaluateAll(chips =>
    chips.map(chip => chip.dataset.condition));
  assert.deepEqual([...actualKeys].sort(), [...expectedKeys].sort(), 'only active approved/requested conditions become chips');
  assert.equal(new Set(actualKeys).size, actualKeys.length, 'no duplicate merged condition chips');
  assert.equal(await keywordContainer.locator('.condition-keywords').count(), expectedKeys.length ? 1 : 0);
  assert.equal(await keywordContainer.locator('.keyword-empty').count(), expectedKeys.length ? 0 : 1);
  assert.equal(await keywordContainer.locator('li.condition-keyword').count(), expectedKeys.length);
  assert.ok((await keywordContainer.locator('.condition-keyword').allTextContents())
    .every(text => text.trim().length > 0 && !text.includes('검색했어요')), 'keywords replace the long condition sentence list');

  const badge = card.locator('.route-card-header .route-type-badge');
  assert.equal(await badge.count(), 1);
  assert.equal(await badge.innerText(), expectedKeys.length ? '이동 조건 검색' : '기본 조건 검색');
  assert.ok(!/더 편|안전|무장애/.test(await badge.innerText()));
  assert.equal(await card.locator('.route-card-header .route-label').innerText(), route.label);
  assert.equal(await card.locator('.route-main').count(), 1);
  assert.equal(await card.locator('[data-field="distanceM"]').count(), 1);
  assert.equal(await card.locator('[data-field="gradeCoveragePercent"]').count(), 1);
  assert.ok((await box.locator('.explanation-summary').innerText()).trim().length > 0);

  const selectedGentle = trip.profile.gentleSlope === true;
  assert.equal(await box.locator('.slope-preference').count(), selectedGentle ? 1 : 0);
  if (selectedGentle) {
    assert.equal(await box.locator('.slope-preference').innerText(), '급경사 회피 선호를 반영했어요.');
    if (route.gradeCoveragePercent < 100 || route.maxSlopePercent === null || route.ascentM === null) {
      assert.equal(await box.locator('.slope-caution').innerText(), '실제로 더 완만한지는 확인되지 않았어요.');
    }
  } else {
    assert.equal(await box.locator('.slope-caution').count(), 0);
    assert.ok(!actualKeys.includes('gentleSlope'));
  }

  const dataText = await box.locator('.explanation-uncertainties').innerText();
  const percentageValues = [...dataText.matchAll(/(\d+(?:\.\d+)?)%/g)].map(match => Number(match[1]));
  assert.deepEqual(percentageValues, [route.gradeCoveragePercent], 'data guidance uses this route coverage only');
  assert.ok(dataText.includes('90m DEM'));
  if (route.gradeCoveragePercent < 100) assert.ok(/미확인|확인되지 않은/.test(dataText));

  const layout = await card.evaluate(element => {
    const find = selector => element.querySelector(selector);
    const before = (first, second) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    const header = find('.route-card-header'), distance = find('.route-main'), box = find('.route-explanations');
    const facts = find('.explanation-facts'), summary = find('.explanation-summary');
    const slope = find('.explanation-slope'), keywords = find('.explanation-conditions');
    const data = find('.explanation-uncertainties'), preview = find('.route-preview-link');
    const previewSvg = preview?.querySelector('svg'), caption = preview?.querySelector('.preview-caption');
    const caution = find('.slope-caution'), preference = find('.slope-preference');
    const cautionStyle = caution ? getComputedStyle(caution) : null;
    const chips = [...element.querySelectorAll('.condition-keyword')];
    const rows = [];
    for (const chip of chips) {
      const rectangle = chip.getBoundingClientRect();
      const row = rows.find(item => Math.abs(item.top - rectangle.top) < 1);
      if (row) row.count++;
      else rows.push({ top: rectangle.top, count: 1 });
    }
    return {
      headerDistance: before(header, distance), distanceExplanation: before(distance, box),
      isResult: Boolean(element.closest('#routes-container')),
      previewCount: element.querySelectorAll('.route-preview-link').length,
      previewSvgCount: preview?.querySelectorAll('svg').length || 0,
      headerPreviewDistance: !preview || before(header, preview) && before(preview, distance)
        && header.nextElementSibling === preview && preview.nextElementSibling === distance,
      previewCaptionOrder: !preview || Boolean(previewSvg && caption && before(previewSvg, caption)),
      previewBounds: !preview || header.getBoundingClientRect().bottom <= preview.getBoundingClientRect().top + 1
        && preview.getBoundingClientRect().bottom <= distance.getBoundingClientRect().top + 1,
      captionBounds: !preview || Boolean(previewSvg && caption
        && previewSvg.getBoundingClientRect().bottom <= caption.getBoundingClientRect().top + 1),
      factsSummary: before(facts, summary), summaryKeywords: before(summary, keywords),
      slopeOrder: !slope || before(summary, slope) && before(slope, keywords),
      keywordsData: before(keywords, data),
      cardOverflow: element.scrollWidth > element.clientWidth + 1,
      keywordsOverflow: keywords.scrollWidth > keywords.clientWidth + 1,
      chipRows: rows.map(row => row.count),
      distanceSize: parseFloat(getComputedStyle(find('.route-distance')).fontSize),
      factSize: parseFloat(getComputedStyle(facts.querySelector('li')).fontSize),
      headingLeft: find('.route-card-header .route-heading').getBoundingClientRect().left,
      badgeLeft: find('.route-type-badge').getBoundingClientRect().left,
      cautionStyle: cautionStyle ? {
        background: cautionStyle.backgroundColor, color: cautionStyle.color,
        padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(key => parseFloat(cautionStyle[key])),
        radius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']
          .map(key => parseFloat(cautionStyle[key])),
        fontSize: parseFloat(cautionStyle.fontSize),
        preferenceSize: parseFloat(getComputedStyle(preference).fontSize),
      } : null,
    };
  });
  for (const name of ['headerDistance', 'headerPreviewDistance', 'previewCaptionOrder', 'previewBounds', 'captionBounds',
    'distanceExplanation', 'factsSummary', 'summaryKeywords', 'slopeOrder', 'keywordsData'])
    assert.equal(layout[name], true, 'readable information order: ' + name);
  assert.equal(layout.previewCount, layout.isResult ? 1 : 0, 'result has one preview link, detail has none');
  assert.equal(layout.previewSvgCount, layout.isResult ? 1 : 0, 'one existing SVG per result preview');
  if (layout.cautionStyle) {
    assert.ok(['rgba(0, 0, 0, 0)', 'transparent'].includes(layout.cautionStyle.background), 'slope note has no colored background');
    assert.deepEqual(layout.cautionStyle.padding, [0, 0, 0, 0], 'slope note is plain supporting text without box padding');
    assert.deepEqual(layout.cautionStyle.radius, [0, 0, 0, 0], 'slope note has no box corners');
    assert.equal(layout.cautionStyle.color, 'rgb(82, 97, 88)', 'slope note uses the calm gray text color');
    assert.equal(layout.cautionStyle.fontSize, 15, 'slope note remains readable at 15px');
    assert.ok(layout.cautionStyle.fontSize < layout.cautionStyle.preferenceSize, 'slope note is smaller than its preference statement');
  }
  assert.equal(layout.cardOverflow, false);
  assert.equal(layout.keywordsOverflow, false);
  assert.ok(layout.chipRows.every(count => count <= 2), 'mobile badges contain at most two keywords per row');
  assert.ok(layout.distanceSize >= 32, 'total distance has a large font');
  assert.ok(layout.factSize >= 18, 'main comparison has a readable font');
  assert.ok(layout.badgeLeft > layout.headingLeft, 'search type badge is to the right of the route name');
  return { keys: actualKeys, badge: await badge.innerText(), dataText };
}

async function explanationSnapshot(card, route) {
  const box = card.locator('.route-explanations');
  await box.waitFor({ state: 'visible' });
  assert.equal(await box.count(), 1);
  assert.equal(await box.getAttribute('data-route-id'), route.id);
  assert.equal(await box.locator('h3').innerText(), '경로 비교와 요청 조건');
  assert.equal(await card.locator('p.route-reason').innerText(), route.reason,
    'original API reason remains unchanged');
  const facts = await box.locator('.explanation-facts').innerText();
  for (const [field, expression] of [
    ['ascentM', /누적\s*상승/],
    ['maxSlopePercent', /최대\s*경사/],
    ['crosswalkCount', /횡단/],
  ]) {
    if (route[field] === null) assert.ok(!expression.test(facts),
      field + ': unknown metric never becomes a numeric comparison');
  }
  assert.ok(!/완만/.test(facts), 'numeric facts do not claim overall gentleness');
  if (route.gradeCoveragePercent < 100) {
    const uncertainty = await box.locator('.explanation-uncertainties').innerText();
    assert.ok(uncertainty.includes('경사') && uncertainty.includes('확인'));
  }
  await assertReadableCard(card, route);
  return (await box.innerText()).trim();
}

async function assertDetailExplanation(page, route, expected, originalResponse) {
  const detail = page.locator('#route-detail .route-card');
  assert.equal(await explanationSnapshot(detail, route), expected,
    'detail explanation belongs to the selected actual route');
  const stored = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).response, TRIP);
  assert.deepEqual(stored, originalResponse, 'display explanations do not mutate the stored API response');
}

async function assertLeafletRoute(page, response, chosen) {
  await page.waitForFunction(() => window.L?.version === '1.9.4' && window.__p6MapAudit?.lines.length > 0);
  await page.locator('#route-map.leaflet-container').waitFor({ state: 'visible' });
  await page.locator('#route-map path.route-line--selected').waitFor({ state: 'visible' });
  const actual = await page.evaluate(() => {
    const audit = window.__p6MapAudit;
    return {
      version: window.L.version,
      lines: audit.lines.map(({ layer }) => ({
        real: layer instanceof window.L.Polyline,
        coordinates: layer.getLatLngs().map(point => [point.lat, point.lng]),
        className: layer.options.className || '',
        weight: layer.options.weight,
        validBounds: layer.getBounds().isValid(),
      })),
      markers: audit.markers.map(({ layer }) => ({
        real: layer instanceof window.L.CircleMarker,
        coordinates: [layer.getLatLng().lat, layer.getLatLng().lng],
        tooltip: String(layer.getTooltip()?.getContent()?.textContent || layer.getTooltip()?.getContent() || ''),
      })),
      tiles: audit.tiles.map(({ layer, firstArgument }) => ({
        real: layer instanceof window.L.TileLayer,
        template: firstArgument,
        attribution: layer.getAttribution(),
      })),
    };
  });
  assert.equal(actual.version, '1.9.4');
  const leafletScript = page.locator('script[src="' + LEAFLET_JS + '"]');
  const leafletStyles = page.locator('link[rel="stylesheet"][href="' + LEAFLET_CSS + '"]');
  assert.equal(await leafletScript.count(), 1);
  assert.equal(await leafletStyles.count(), 1);
  assert.equal(await leafletScript.getAttribute('integrity'), 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=');
  assert.equal(await leafletStyles.getAttribute('integrity'), 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=');
  for (const asset of [leafletScript, leafletStyles]) {
    assert.ok(['', 'anonymous'].includes(await asset.getAttribute('crossorigin')));
  }
  assert.equal(actual.lines.length, response.routes.length);
  assert.ok(actual.lines.every(line => line.real && line.validBounds));
  for (const route of response.routes) {
    const expected = route.coordinates.map(([lng, lat]) => [lat, lng]);
    const line = actual.lines.find(item => JSON.stringify(item.coordinates) === JSON.stringify(expected));
    assert.ok(line, 'real Leaflet geometry for ' + route.id);
    assert.equal(line.className.split(/\s+/).includes('route-line--selected'), route.id === chosen.id);
  }
  assert.equal(actual.lines.filter(line => line.className.split(/\s+/).includes('route-line--selected')).length, 1);
  assert.equal(actual.markers.length, 2);
  assert.ok(actual.markers.every(marker => marker.real));
  const first = chosen.coordinates[0], last = chosen.coordinates[chosen.coordinates.length - 1];
  assert.deepEqual(actual.markers.map(marker => marker.coordinates), [[first[1], first[0]], [last[1], last[0]]]);
  assert.ok(actual.markers[0].tooltip.includes('출발') && actual.markers[0].tooltip.includes('보행 노드'));
  assert.ok(actual.markers[1].tooltip.includes('도착') && actual.markers[1].tooltip.includes('보행 노드'));
  assert.equal(actual.tiles.length, 1);
  assert.equal(actual.tiles[0].real, true);
  assert.equal(actual.tiles[0].template, TILE_TEMPLATE);
  assert.ok(actual.tiles[0].attribution.includes('OpenStreetMap'));
  assert.ok((await page.locator('#route-map .leaflet-control-attribution').innerText()).includes('OpenStreetMap'));
  assert.ok((await page.locator('#map-endpoint-note').innerText()).match(/보행|노드|스냅/));
  return actual;
}

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.NARANHI_CHROME_PATH || undefined, headless: true,
  });
  const context = await observedContext(browser, 'main');
  const page = await context.newPage();
  let result, chosen, routeStatus, backgroundTilesVisible = false;
  function report(status, error) {
    const mainTiles = networkResponses.filter(item => item.case === 'main' && TILE_URL.test(item.url));
    return { status, passed: completed.length, checks: completed, p7Cases, p8Examples, readabilityExamples,
      routeApi: result ? { status: routeStatus, count: result.routes.length, sameRoute: result.sameRoute,
        routes: result.routes.map(({ id, label, distanceM, ascentM, maxSlopePercent,
          gradeCoveragePercent, stairsCount, crosswalkCount, coordinates }) => ({
          id, label, distanceM, ascentM, maxSlopePercent, gradeCoveragePercent, stairsCount,
          crosswalkCount, coordinateCount: coordinates.length,
        })) } : null,
      leaflet: { expectedVersion: '1.9.4', tileTemplate: TILE_TEMPLATE,
        successfulMainTileResponses: mainTiles.filter(item => item.status === 200).length,
        backgroundTilesVisible, backgroundVerified: backgroundTilesVisible && mainTiles.some(item => item.status === 200) },
      successfulResponses: 'real FastAPI/A and real Leaflet only',
      errorInjection: 'NO_ROUTE response, Leaflet JS abort, and OSM tile abort display checks only',
      pageErrors: errors, externalRequests, networkResponses, networkFailures,
      unexpectedExternalRequests: externalRequests.filter(item => !externalAllowed(item.url)),
      error: error?.stack, artifacts };
  }
  try {
    await page.goto(base + '/');
    await page.waitForURL('**/profile.html');
    await page.check('input[name="stairs"]');
    await page.check('input[name="gentleSlope"]');
    await page.uncheck('input[name="crosswalks"]');
    await page.check('input[name="comfortFirst"]');
    await shot(page, '01-profile-mobile');
    await page.click('#profile-form button[type="submit"]');
    await page.waitForURL('**/home.html');
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), PROFILE);
    assert.deepEqual(saved, profile);
    completed.push('profile saved as API values in localStorage');

    await selectPlaces(page);
    await page.fill('#today-status', rawText);
    await shot(page, '02-home-mobile');
    const [parsedResponse] = await Promise.all([
      apiResponse(page, '/api/conditions/parse'), page.click('#parse-button'),
    ]);
    assert.equal(parsedResponse.status(), 200);
    const parsed = await parsedResponse.json();
    assert.deepEqual(parsed.today, { suitcase: true, avoidStairs: true });
    await page.locator('#parse-panel').waitFor({ state: 'visible' });
    assert.equal(requests.filter(r => r.url.endsWith('/api/routes')).length, 0);
    assert.ok((await page.locator('#parse-terms').innerText()).includes('캐리어'));
    await page.uncheck('#parse-conditions input[name="avoidStairs"]');
    for (const state of await page.locator('.condition-state').all())
      assert.ok((await state.boundingBox()).width >= 200, 'confirmation description stays readable');
    await shot(page, '03-confirmation-mobile');
    const [routeResponse] = await Promise.all([
      apiResponse(page, '/api/routes'), page.click('#parse-confirm-button'),
    ]);
    routeStatus = routeResponse.status();
    assert.equal(routeStatus, 200);
    const submitted = requests.find(r => r.url.endsWith('/api/routes')).body;
    assert.deepEqual(submitted.today, { suitcase: true, avoidStairs: false });
    assert.deepEqual(submitted.profile, profile);
    await page.waitForURL('**/result.html');
    // The app persists the actual API response before navigating. Chrome can
    // release a fetch response body on navigation; backend tests compare it to A.
    const actualTrip = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), TRIP);
    result = actualTrip.response;
    const verifyResponse = await context.request.post(base + '/api/routes', { data: submitted });
    assert.equal(verifyResponse.status(), 200);
    const verifiedApiResponse = await verifyResponse.json();
    const withoutRequestId = ({ requestId, ...body }) => body;
    assert.deepEqual(withoutRequestId(result), withoutRequestId(verifiedApiResponse),
      'stored response keeps the original API contract and values');
    const explanationById = new Map();
    const cards = page.locator('.route-card');
    assert.equal(await cards.count(), result.routes.length);
    assert.ok(result.routes.length >= 1 && result.routes.length <= 3);
    assert.equal(await page.locator('.leaflet-container').count(), 0);
    const sameRouteMessage = await page.locator('#same-route-message').innerText();
    assert.ok(sameRouteMessage.includes(result.sameRoute ? '같습니다' : '서로 다릅니다'));
    for (let i = 0; i < result.routes.length; i++) {
      const item = result.routes[i], card = cards.nth(i);
      assert.equal(await card.getAttribute('data-route-id'), item.id);
      const text = await card.innerText();
      assert.ok(text.includes(item.label));
      const explanation = await explanationSnapshot(card, item);
      explanationById.set(item.id, explanation);
      assert.match(await card.locator('.route-number').innerText(), /^\d+번\s*경로$/);
      p8Examples.push({ routeId: item.id, label: item.label, explanation, originalReason: item.reason });
      for (const field of ['ascentM', 'maxSlopePercent', 'crosswalkCount']) {
        const metric = await card.locator('[data-field="' + field + '"]').innerText();
        if (item[field] === null) assert.ok(metric.includes('정보 미확인'), field);
      }
      const coverage = await card.locator('[data-field="gradeCoveragePercent"]').innerText();
      assert.equal(parseFloat(coverage), item.gradeCoveragePercent);
      for (const warning of item.warnings) assert.ok(text.includes(warning));
      const preview = card.locator('a.route-preview-link');
      assert.equal(await preview.getAttribute('href'), '/route.html?routeId=' + encodeURIComponent(item.id));
      assert.ok(await preview.getAttribute('aria-label'), 'preview link has an accessible name');
      assert.equal(await preview.locator('svg polyline').count(), 1);
      const points = (await preview.locator('svg polyline').getAttribute('points')).trim().split(/\s+/);
      assert.equal(points.length, item.coordinates.length);
      assert.ok(points.every(point => point.split(',').every(value => Number.isFinite(Number(value)))));
    }
    const firstFacts = await cards.nth(0).locator('.explanation-facts').innerText();
    const expectedDistanceDifference = Number(Math.abs(result.routes[1].distanceM - result.routes[0].distanceM).toFixed(1));
    assert.ok(firstFacts.includes(expectedDistanceDifference.toLocaleString('ko-KR') + 'm'));
    assert.ok(firstFacts.includes('2번'), 'comparison names the actual numbered reference route');
    assert.ok((await cards.nth(0).locator('.explanation-conditions').innerText()).includes('캐리어'));
    assert.ok(!(await cards.nth(0).locator('.explanation-conditions').innerText()).includes('유모차'));
    for (const warning of result.warnings)
      assert.ok((await page.locator('#global-warnings').innerText()).includes(warning));
    assert.ok(!/\d+\s*분/.test(await page.locator('body').innerText()));
    assert.ok(!(await page.locator('body').innerText()).includes('가장 빠른 길'));
    await page.setViewportSize({ width: 320, height: 844 });
    await assertReadableCard(cards.nth(0), result.routes[0]);
    await shot(page, '04-results-mobile-320');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, '04-results-mobile');
    const storedTrip = await page.evaluate(key => sessionStorage.getItem(key), TRIP);
    assert.ok(!storedTrip.includes(rawText));
    chosen = result.routes[Math.min(1, result.routes.length - 1)];
    await page.locator('.route-card[data-route-id="' + chosen.id + '"] .route-preview-link').click();
    await waitForRoute(page, chosen.id);
    await assertLeafletRoute(page, result, chosen);
    await assertDetailExplanation(page, chosen, explanationById.get(chosen.id), result);
    try {
      await page.waitForFunction(() => Array.from(document.querySelectorAll('#route-map img.leaflet-tile'))
        .some(tile => tile.complete && tile.naturalWidth > 0), null, { timeout: 10000 });
      backgroundTilesVisible = true;
    } catch (_) {
      // Geometry still has to pass above. The report explicitly distinguishes
      // successful map geometry from unverified external background tiles.
      backgroundTilesVisible = false;
    }
    assert.ok((await page.locator('#route-detail').innerText()).includes(chosen.label));
    await page.click('#choose-route-button');
    assert.ok((await page.locator('#selected-status').innerText()).length > 0);
    assert.equal(requests.filter(r => r.url.includes('route-selections')).length, 0);
    await page.setViewportSize({ width: 320, height: 844 });
    await assertReadableCard(page.locator('#route-detail .route-card'), chosen);
    await shot(page, '05-detail-mobile-320');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, '05-detail-mobile');
    completed.push('approved partial today only, real routes, labels, nulls, coverage, warnings, SVG previews and Leaflet geometry');

    await page.locator('a.back-link[href="/result.html"]').click();
    await page.waitForURL('**/result.html');
    const keyboardRoute = result.routes[0];
    const keyboardPreview = page.locator('.route-card[data-route-id="' + keyboardRoute.id + '"] .route-preview-link');
    await keyboardPreview.focus();
    await keyboardPreview.press('Enter');
    await waitForRoute(page, keyboardRoute.id);
    await assertLeafletRoute(page, result, keyboardRoute);
    await assertDetailExplanation(page, keyboardRoute, explanationById.get(keyboardRoute.id), result);
    assert.equal(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).selectedRouteId, TRIP), keyboardRoute.id);
    await page.locator('a.back-link[href="/result.html"]').click();
    await page.waitForURL('**/result.html');
    const linkedRoute = result.routes[result.routes.length - 1];
    await page.locator('.route-card[data-route-id="' + linkedRoute.id + '"] .route-link:not(.route-preview-link)').click();
    await waitForRoute(page, linkedRoute.id);
    await assertLeafletRoute(page, result, linkedRoute);
    await assertDetailExplanation(page, linkedRoute, explanationById.get(linkedRoute.id), result);
    completed.push('pointer SVG preview, keyboard Enter, and route text link retain exact route id');

    await page.goto(base + '/check.html?routeId=' + encodeURIComponent(chosen.id));
    await page.locator('#route-detail').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#route-detail').innerText()).includes(chosen.label));
    assert.equal(await page.locator('.leaflet-container').count(), 0);
    const checkPoints = (await page.locator('#route-map polyline').getAttribute('points')).trim().split(/\s+/);
    assert.equal(checkPoints.length, chosen.coordinates.length);
    assert.ok((await page.locator('body').innerText()).includes('배경지도 미포함'));
    await shot(page, '06-warning-mobile');
    await page.goto(base + '/route.html?routeId=not-a-route');
    await page.locator('#empty-state').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#route-map polyline').count(), 0);
    assert.equal(await page.locator('.leaflet-container').count(), 0);
    assert.equal(await page.evaluate(() => window.__p6MapAudit?.lines.length || 0), 0);
    completed.push('unknown route id shows empty state');

    await page.goto(base + '/profile.html');
    assert.equal(await page.locator('input[name="comfortFirst"]').isChecked(), true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await shot(page, 'profile-desktop');
    completed.push('profile restored, mobile and desktop layouts');

    const direct = await preparedHome(browser, 'empty-today');
    let parseCalls = 0;
    direct.page.on('request', r => { if (r.url().endsWith('/api/conditions/parse')) parseCalls++; });
    const [directResponse] = await Promise.all([
      apiResponse(direct.page, '/api/routes'), direct.page.click('#search-button'),
    ]);
    assert.equal(directResponse.status(), 200);
    await direct.page.waitForURL('**/result.html');
    assert.equal(parseCalls, 0);
    completed.push('empty today skips parser and requests real routes');
    await closeContext(direct.context);

    const failure = await preparedHome(browser, 'api-errors');
    await failure.page.fill('#today-status', '오늘은 날씨가 좋아요');
    await Promise.all([
      apiResponse(failure.page, '/api/conditions/parse'), failure.page.click('#parse-button'),
    ]);
    await failure.page.locator('#parse-panel').waitFor({ state: 'visible' });
    assert.ok((await failure.page.locator('#parse-warning').innerText()).length > 0);
    await failure.page.click('#parse-edit-button');
    await failure.page.fill('#today-status', '가'.repeat(501));
    await failure.page.click('#parse-button');
    await failure.page.locator('#form-error').waitFor({ state: 'visible' });
    assert.ok(failure.page.url().endsWith('/home.html'));
    await failure.page.fill('#today-status', '');
    await failure.page.route('**/api/routes', route => route.fulfill({
      status: 404, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NO_ROUTE', message: '현재 조건에 맞는 경로가 없습니다.' } }),
    }));
    await failure.page.click('#search-button');
    await failure.page.locator('#form-error').waitFor({ state: 'visible' });
    assert.ok((await failure.page.locator('#form-error').innerText()).includes('경로가 없습니다'));
    assert.ok(failure.page.url().endsWith('/home.html'));
    assert.equal(await failure.page.locator('#search-button').isDisabled(), false);
    await shot(failure.page, 'error-mobile');
    completed.push('unrecognized warning, length validation, controlled NO_ROUTE failure without success screen');
    await closeContext(failure.context);

    const libraryFailure = await observedContext(browser, 'library-failure', { trip: actualTrip, abortLibrary: true });
    const libraryPage = await libraryFailure.newPage();
    await libraryPage.goto(base + '/route.html?routeId=' + encodeURIComponent(chosen.id));
    await libraryPage.locator('#map-warning').waitFor({ state: 'visible' });
    assert.ok((await libraryPage.locator('#map-warning').innerText()).includes('지도를 불러오지 못했습니다'));
    assert.ok((await libraryPage.locator('#route-detail').innerText()).includes(chosen.label));
    assert.equal(await libraryPage.locator('.leaflet-container').count(), 0);
    await libraryPage.click('#choose-route-button');
    assert.ok((await libraryPage.locator('#selected-status').innerText()).length > 0);
    await shot(libraryPage, 'leaflet-library-failure-mobile');
    await libraryPage.locator('a.back-link[href="/result.html"]').click();
    await libraryPage.waitForURL('**/result.html');
    assert.equal(await libraryPage.locator('.route-card').count(), result.routes.length);
    completed.push('Leaflet library failure preserves actual route metrics, selection, and return navigation');
    await closeContext(libraryFailure);

    const tilesFailure = await observedContext(browser, 'tile-failure', { trip: actualTrip, abortTiles: true });
    const tilesPage = await tilesFailure.newPage();
    await tilesPage.goto(base + '/route.html?routeId=' + encodeURIComponent(chosen.id));
    await assertLeafletRoute(tilesPage, result, chosen);
    await tilesPage.locator('#map-warning').waitFor({ state: 'visible' });
    assert.ok((await tilesPage.locator('#map-warning').innerText()).includes('배경지도'));
    assert.ok((await tilesPage.locator('#route-detail').innerText()).includes(chosen.label));
    await shot(tilesPage, 'osm-tile-failure-mobile');
    completed.push('OSM tile failure keeps real selected route geometry and displays background warning');
    await closeContext(tilesFailure);

    // P7: keep the P6 scenarios above and exercise new places through the UI.
    const p7 = await preparedHome(browser, 'p7-places');
    const expectedPlaces = [
      { id: 'duksung_gate', name: '덕성여대 정문', lat: 37.6517, lng: 127.0149 },
      { id: 'hyomun_gate', name: '효문중고 출입구', lat: 37.6526, lng: 127.0174 },
      { id: 'duksung_dorm', name: '덕성여대 기숙사', lat: 37.6491330337407, lng: 127.022277801401 },
      { id: 'april19_station_exit1', name: '4·19민주묘지역 1번 출구', lat: 37.649707, lng: 127.013733 },
    ];
    const dorm = expectedPlaces[2], station = expectedPlaces[3];
    const directions = [
      { id: 'station-to-dorm', start: station, end: dorm },
      { id: 'dorm-to-station', start: dorm, end: station },
    ];
    const conditions = [
      { id: 'normal', text: '', today: null },
      { id: 'suitcase', text: '캐리어가 있어요', today: { suitcase: true } },
      { id: 'stroller', text: '유모차를 끌고 있어요', today: { stroller: true } },
    ];
    for (const direction of directions) {
      for (const condition of conditions) {
        await p7.page.goto(base + '/home.html');
        await p7.page.locator('#start option[value="duksung_dorm"]').waitFor({ state: 'attached' });
        for (const id of ['start', 'end']) {
          const choices = await p7.page.locator('#' + id + ' option').evaluateAll(options =>
            options.map(option => ({ id: option.value, name: option.textContent.trim() })));
          assert.deepEqual(choices, expectedPlaces.map(({ id, name }) => ({ id, name })));
        }
        await p7.page.selectOption('#start', direction.start.id);
        await p7.page.selectOption('#end', direction.end.id);
        await p7.page.fill('#today-status', condition.text);
        if (condition.id === 'normal')
          await shot(p7.page, 'p7-' + direction.id + '-home-mobile');
        const requestOffset = requests.length;
        let routeResponseP7;
        if (condition.today) {
          const [parseResponseP7] = await Promise.all([
            apiResponse(p7.page, '/api/conditions/parse'), p7.page.click('#parse-button'),
          ]);
          assert.equal(parseResponseP7.status(), 200);
          const parsedP7 = await parseResponseP7.json();
          assert.deepEqual(parsedP7.today, condition.today);
          assert.equal(parsedP7.requiresConfirmation, true);
          await p7.page.locator('#parse-panel').waitFor({ state: 'visible' });
          assert.equal(requests.slice(requestOffset).filter(item => item.url.endsWith('/api/routes')).length, 0,
            'new-place route is not requested before condition confirmation');
          [routeResponseP7] = await Promise.all([
            apiResponse(p7.page, '/api/routes'), p7.page.click('#parse-confirm-button'),
          ]);
        } else {
          [routeResponseP7] = await Promise.all([
            apiResponse(p7.page, '/api/routes'), p7.page.click('#search-button'),
          ]);
          assert.equal(requests.slice(requestOffset).filter(item => item.url.endsWith('/api/conditions/parse')).length, 0);
        }
        assert.equal(routeResponseP7.status(), 200);
        const submittedP7 = requests.slice(requestOffset).filter(item => item.url.endsWith('/api/routes'));
        assert.equal(submittedP7.length, 1);
        assert.deepEqual(submittedP7[0].body.start, { lat: direction.start.lat, lng: direction.start.lng });
        assert.deepEqual(submittedP7[0].body.end, { lat: direction.end.lat, lng: direction.end.lng });
        assert.deepEqual(submittedP7[0].body.profile, profile);
        if (condition.today) assert.deepEqual(submittedP7[0].body.today, condition.today);
        else assert.equal(Object.prototype.hasOwnProperty.call(submittedP7[0].body, 'today'), false);
        await p7.page.waitForURL('**/result.html');
        const savedTripP7 = await p7.page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), TRIP);
        assert.equal(savedTripP7.start.id, direction.start.id);
        assert.equal(savedTripP7.end.id, direction.end.id);
        assert.equal(savedTripP7.start.name, direction.start.name);
        assert.equal(savedTripP7.end.name, direction.end.name);
        if (condition.text)
          assert.ok(!(await p7.page.evaluate(key => sessionStorage.getItem(key), TRIP)).includes(condition.text));
        const responseP7 = savedTripP7.response;
        assert.ok(responseP7.routes.length >= 1 && responseP7.routes.length <= 3);
        const p7Cards = p7.page.locator('.route-card');
        const p7ExplanationById = new Map();
        assert.equal(await p7Cards.count(), responseP7.routes.length);
        const summaryP7 = await p7.page.locator('#trip-summary').innerText();
        assert.ok(summaryP7.includes(direction.start.name) && summaryP7.includes(direction.end.name));
        const sameP7 = await p7.page.locator('#same-route-message').innerText();
        assert.ok(sameP7.includes(responseP7.sameRoute ? '같습니다' : '서로 다릅니다'));
        for (let index = 0; index < responseP7.routes.length; index++) {
          const route = responseP7.routes[index], card = p7Cards.nth(index);
          assert.equal(await card.getAttribute('data-route-id'), route.id);
          const cardText = await card.innerText();
          assert.ok(cardText.includes(route.label));
          p7ExplanationById.set(route.id, await explanationSnapshot(card, route));
          for (const field of ['ascentM', 'maxSlopePercent', 'crosswalkCount']) {
            const text = await card.locator('[data-field="' + field + '"]').innerText();
            if (route[field] === null) assert.ok(text.includes('정보 미확인'));
          }
          assert.equal(parseFloat(await card.locator('[data-field="gradeCoveragePercent"]').innerText()),
            route.gradeCoveragePercent);
          for (const warning of route.warnings) assert.ok(cardText.includes(warning));
          const points = (await card.locator('.route-preview-link svg polyline').getAttribute('points')).trim().split(/\s+/);
          assert.equal(points.length, route.coordinates.length);
        }
        for (const warning of responseP7.warnings)
          assert.ok((await p7.page.locator('#global-warnings').innerText()).includes(warning));
        assert.ok(!/\d+\s*분/.test(await p7.page.locator('body').innerText()));
        const routeP7 = responseP7.routes[0];
        await p7.page.locator('.route-card[data-route-id="' + routeP7.id + '"] .route-preview-link').click();
        await waitForRoute(p7.page, routeP7.id);
        await assertLeafletRoute(p7.page, responseP7, routeP7);
        await assertDetailExplanation(p7.page, routeP7, p7ExplanationById.get(routeP7.id), responseP7);
        assert.ok((await p7.page.locator('#trip-summary').innerText()).includes(station.name));
        assert.ok((await p7.page.locator('#route-detail').innerText()).includes(routeP7.label));
        let newPlaceBackgroundVisible = null;
        if (condition.id === 'normal') {
          try {
            await p7.page.waitForFunction(() => Array.from(document.querySelectorAll('#route-map img.leaflet-tile'))
              .some(tile => tile.complete && tile.naturalWidth > 0), null, { timeout: 10000 });
            newPlaceBackgroundVisible = true;
          } catch (_) {
            newPlaceBackgroundVisible = false;
          }
          await shot(p7.page, 'p7-' + direction.id + '-route-mobile');
        }
        assert.deepEqual(await p7.page.evaluate(key => JSON.parse(localStorage.getItem(key)), PROFILE), profile);
        p7Cases.push({ direction: direction.id, condition: condition.id, status: routeResponseP7.status(),
          start: direction.start.id, end: direction.end.id,
          routeCount: responseP7.routes.length, sameRoute: responseP7.sameRoute,
          backgroundTilesVisible: newPlaceBackgroundVisible,
          routes: responseP7.routes.map(route => ({ id: route.id, label: route.label,
            distanceM: route.distanceM, gradeCoveragePercent: route.gradeCoveragePercent,
            coordinateCount: route.coordinates.length, stairsCount: route.stairsCount,
            ascentM: route.ascentM, maxSlopePercent: route.maxSlopePercent, crosswalkCount: route.crosswalkCount })),
        });
        completed.push('P7 ' + direction.id + ' ' + condition.id + ': four places, exact input coordinates and confirmed state, real SVG and Leaflet route');
      }
    }
    await closeContext(p7.context);

    // P8 finishing cases use real requests with explicit profiles. The custom
    // seed survives navigation instead of restoring the default true preference.
    const readabilityCases = [
      { id: 'slope-unselected', hasTouch: true, savedProfile: { ...profile, gentleSlope: false, crosswalks: 'avoid' } },
      { id: 'basic-conditions', savedProfile: { stairs: 'allowed', detourAllowed: false, gentleSlope: false,
        crosswalks: 'allowed', comfortFirst: false } },
    ];
    for (const sample of readabilityCases) {
      const readability = await preparedHome(browser, 'p8-' + sample.id, sample.savedProfile, { hasTouch: sample.hasTouch === true });
      const offset = requests.length;
      const [actualResponse] = await Promise.all([
        apiResponse(readability.page, '/api/routes'), readability.page.click('#search-button'),
      ]);
      assert.equal(actualResponse.status(), 200);
      const request = requests.slice(offset).find(item => item.url.endsWith('/api/routes'));
      assert.deepEqual(request.body.profile, sample.savedProfile);
      assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'today'), false);
      await readability.page.waitForURL('**/result.html');
      const trip = await readability.page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), TRIP);
      assert.deepEqual(trip.profile, sample.savedProfile);
      const route = trip.response.routes[0];
      const card = readability.page.locator('.route-card').nth(0);
      const snapshot = await explanationSnapshot(card, route);
      const summary = await assertReadableCard(card, route);
      assert.equal(await card.locator('.slope-preference').count(), 0);
      assert.equal(await card.locator('.slope-caution').count(), 0);
      assert.ok(!summary.keys.includes('gentleSlope'));
      if (sample.id === 'basic-conditions') assert.deepEqual(summary.keys, []);
      await shot(readability.page, 'p8-' + sample.id + '-result-mobile');
      const previewTouches = [];
      if (sample.hasTouch) {
        assert.ok(await readability.page.evaluate(() => navigator.maxTouchPoints > 0), 'touch scenario has a real touch-capable browser context');
        await readability.page.exposeFunction('__naranhiPreviewTouch', isTrusted => previewTouches.push(isTrusted));
        await card.locator('.route-preview-link').evaluate(element => element.addEventListener('touchstart', event => {
          window.__naranhiPreviewTouch(event.isTrusted);
        }, { once: true, passive: true }));
        await card.locator('.route-preview-link').tap();
      } else await card.locator('.route-preview-link').click();
      await waitForRoute(readability.page, route.id);
      if (sample.hasTouch) assert.deepEqual(previewTouches, [true], 'trusted preview touch keeps the selected route id');
      await assertLeafletRoute(readability.page, trip.response, route);
      await assertDetailExplanation(readability.page, route, snapshot, trip.response);
      await shot(readability.page, 'p8-' + sample.id + '-detail-mobile');
      readabilityExamples.push({ case: sample.id, gentleSlope: false, ...summary,
        actualApiStatus: actualResponse.status(), routeId: route.id, distanceM: route.distanceM,
        previewInteraction: sample.hasTouch ? 'trusted touch' : 'mouse click' });
      completed.push('P8 ' + sample.id + ': actual request, active keywords only, conditional slope text, matching result/detail');
      await closeContext(readability.context);
    }

    const emptyContext = await observedContext(browser, 'p8-empty-result');
    const emptyPage = await emptyContext.newPage();
    const beforeEmptyRequests = requests.length;
    await emptyPage.goto(base + '/result.html');
    await emptyPage.locator('#empty-state').waitFor({ state: 'visible' });
    assert.equal(await emptyPage.locator('#empty-state').count(), 1);
    assert.equal(await emptyPage.locator('a.back-link[href="/home.html"]').count(), 1);
    const emptyPlacement = await emptyPage.evaluate(() => {
      const empty = document.getElementById('empty-state');
      const back = document.querySelector('main.result > a.back-link');
      const intro = document.querySelector('.result-intro');
      const routes = document.getElementById('routes-container');
      const precedes = (first, second) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { emptyBeforeIntro: precedes(empty, intro), backBeforeIntro: precedes(back, intro),
        emptyBeforeRoutes: precedes(empty, routes), backBeforeRoutes: precedes(back, routes) };
    });
    assert.deepEqual(emptyPlacement, { emptyBeforeIntro: true, backBeforeIntro: true,
      emptyBeforeRoutes: true, backBeforeRoutes: true });
    assert.equal(await emptyPage.locator('.route-card').count(), 0);
    assert.equal(requests.slice(beforeEmptyRequests).filter(item => item.url.includes('/api/')).length, 0);
    await shot(emptyPage, 'p8-empty-result-mobile');
    completed.push('P8 empty result has one top empty state and return link without fabricated routes');
    await closeContext(emptyContext);

    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests.filter(item => !externalAllowed(item.url)), []);
    const resultReport = report('passed');
    await fs.writeFile(path.join(artifacts, 'browser-report.json'), JSON.stringify(resultReport, null, 2));
    console.log(JSON.stringify(resultReport, null, 2));
  } catch (error) {
    const failureReport = report('failed', error);
    await fs.writeFile(path.join(artifacts, 'browser-report.json'), JSON.stringify(failureReport, null, 2));
    console.error(JSON.stringify(failureReport, null, 2));
    throw error;
  } finally {
    for (const openContext of contexts) await openContext.close();
    await browser.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
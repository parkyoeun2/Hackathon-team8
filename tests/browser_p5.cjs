// Isolated real-browser integration checks. Successful API and Leaflet responses are never mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.NARANHI_PLAYWRIGHT_MODULE || 'playwright');

const base = process.env.NARANHI_TEST_URL || 'http://127.0.0.1:8001';
const artifacts = path.resolve(process.env.NARANHI_TEST_ARTIFACTS || '.p5-artifacts');
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
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

async function preparedHome(browser, label) {
  const context = await observedContext(browser, label);
  await context.addInitScript(({ key, value, expectedOrigin }) => {
    if (location.origin === expectedOrigin) localStorage.setItem(key, JSON.stringify(value));
  }, { key: PROFILE, value: profile, expectedOrigin: new URL(base).origin });
  const page = await context.newPage();
  await page.goto(base + '/home.html');
  await selectPlaces(page);
  return { context, page };
}

async function waitForRoute(page, id) {
  await page.waitForURL(url => url.pathname === '/route.html' && url.searchParams.get('routeId') === id);
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
    return { status, passed: completed.length, checks: completed,
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
    for (const warning of result.warnings)
      assert.ok((await page.locator('#global-warnings').innerText()).includes(warning));
    assert.ok(!/\d+\s*분/.test(await page.locator('body').innerText()));
    assert.ok(!(await page.locator('body').innerText()).includes('가장 빠른 길'));
    await shot(page, '04-results-mobile');
    const storedTrip = await page.evaluate(key => sessionStorage.getItem(key), TRIP);
    assert.ok(!storedTrip.includes(rawText));
    chosen = result.routes[Math.min(1, result.routes.length - 1)];
    await page.locator('.route-card[data-route-id="' + chosen.id + '"] .route-preview-link').click();
    await waitForRoute(page, chosen.id);
    await assertLeafletRoute(page, result, chosen);
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
    assert.equal(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).selectedRouteId, TRIP), keyboardRoute.id);
    await page.locator('a.back-link[href="/result.html"]').click();
    await page.waitForURL('**/result.html');
    const linkedRoute = result.routes[result.routes.length - 1];
    await page.locator('.route-card[data-route-id="' + linkedRoute.id + '"] .route-link:not(.route-preview-link)').click();
    await waitForRoute(page, linkedRoute.id);
    await assertLeafletRoute(page, result, linkedRoute);
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
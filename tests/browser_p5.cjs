// Isolated real-browser integration checks. No successful API response is mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.NARANHI_PLAYWRIGHT_MODULE || 'playwright');

const base = process.env.NARANHI_TEST_URL || 'http://127.0.0.1:8001';
const artifacts = path.resolve(process.env.NARANHI_TEST_ARTIFACTS || '.p5-artifacts');
const PROFILE = 'naranhi.profile.v1';
const TRIP = 'naranhi.trip.v1';
const rawText = '캐리어가 있어요. 계단은 피하고 싶어요.';
const profile = { stairs: 'avoid', detourAllowed: true, gentleSlope: true,
  crosswalks: 'allowed', comfortFirst: true };
const completed = [];

async function shot(page, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    `${name}: horizontal overflow`);
  await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true });
}

async function selectPlaces(page) {
  await page.locator('#start option[value="duksung_gate"]').waitFor({ state: 'attached' });
  await page.selectOption('#start', 'duksung_gate');
  await page.selectOption('#end', 'hyomun_gate');
}

function apiResponse(page, endpoint) {
  return page.waitForResponse(response =>
    response.url() === `${base}${endpoint}` && response.request().method() === 'POST');
}

async function preparedHome(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: PROFILE, value: profile });
  const page = await context.newPage();
  await page.goto(`${base}/home.html`);
  await selectPlaces(page);
  return { context, page };
}

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.NARANHI_CHROME_PATH || undefined, headless: true,
  });
  const errors = [];
  const externalRequests = [];
  const requests = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith('http') && !request.url().startsWith(`${base}/`))
      externalRequests.push(request.url());
    if (request.method() === 'POST' && request.url().startsWith(`${base}/api/`))
      requests.push({ url: request.url(), body: request.postDataJSON() });
  });
  try {
    await page.goto(`${base}/`);
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
    for (const state of await page.locator('.condition-state').all()) {
      assert.ok((await state.boundingBox()).width >= 200, 'confirmation description stays readable');
    }
    await shot(page, '03-confirmation-mobile');
    const [routeResponse] = await Promise.all([
      apiResponse(page, '/api/routes'), page.click('#parse-confirm-button'),
    ]);
    assert.equal(routeResponse.status(), 200);
    const submitted = requests.find(r => r.url.endsWith('/api/routes')).body;
    assert.deepEqual(submitted.today, { suitcase: true, avoidStairs: false });
    assert.deepEqual(submitted.profile, profile);
    await page.waitForURL('**/result.html');
    // Chrome may release the fetch body after navigation. Read the actual API
    // response persisted by the app, which backend HTTP tests compare with A.
    const result = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).response, TRIP);
    const cards = page.locator('.route-card');
    assert.equal(await cards.count(), result.routes.length);
    assert.ok(result.routes.length >= 1 && result.routes.length <= 3);
    const sameRouteMessage = await page.locator('#same-route-message').innerText();
    assert.ok(sameRouteMessage.includes(result.sameRoute ? '같습니다' : '서로 다릅니다'));
    for (let i = 0; i < result.routes.length; i++) {
      const item = result.routes[i];
      const card = cards.nth(i);
      assert.equal(await card.getAttribute('data-route-id'), item.id);
      const text = await card.innerText();
      assert.ok(text.includes(item.label));
      for (const field of ['ascentM', 'maxSlopePercent', 'crosswalkCount']) {
        const metric = await card.locator(`[data-field="${field}"]`).innerText();
        if (item[field] === null) assert.ok(metric.includes('정보 미확인'), field);
      }
      const coverage = await card.locator('[data-field="gradeCoveragePercent"]').innerText();
      assert.equal(parseFloat(coverage), item.gradeCoveragePercent);
      for (const warning of item.warnings) assert.ok(text.includes(warning));
    }
    for (const warning of result.warnings)
      assert.ok((await page.locator('#global-warnings').innerText()).includes(warning));
    assert.ok(!/\d+\s*분/.test(await page.locator('body').innerText()));
    assert.ok(!(await page.locator('body').innerText()).includes('가장 빠른 길'));
    await shot(page, '04-results-mobile');
    const storedTrip = await page.evaluate(key => sessionStorage.getItem(key), TRIP);
    assert.ok(!storedTrip.includes(rawText));
    const chosen = result.routes[Math.min(1, result.routes.length - 1)];
    await page.locator(`.route-card[data-route-id="${chosen.id}"] .route-link`).click();
    await page.waitForURL('**/route.html?routeId=*');
    await page.locator('#route-map polyline').waitFor({ state: 'attached' });
    const pointCount = (await page.locator('#route-map polyline').getAttribute('points'))
      .trim().split(/\s+/).length;
    assert.equal(pointCount, chosen.coordinates.length);
    const detail = await page.locator('#route-detail').innerText();
    assert.ok(detail.includes(chosen.label));
    assert.ok((await page.locator('body').innerText()).includes('배경지도 미포함'));
    await page.click('#choose-route-button');
    assert.ok((await page.locator('#selected-status').innerText()).length > 0);
    assert.equal(requests.filter(r => r.url.includes('route-selections')).length, 0);
    await shot(page, '05-detail-mobile');
    completed.push('approved partial today only, real routes, labels, nulls, coverage, warnings, SVG coordinates');

    await page.goto(`${base}/check.html?routeId=${encodeURIComponent(chosen.id)}`);
    await page.locator('#route-detail').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#route-detail').innerText()).includes(chosen.label));
    await shot(page, '06-warning-mobile');
    await page.goto(`${base}/route.html?routeId=not-a-route`);
    await page.locator('#empty-state').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#route-map polyline').count(), 0);
    completed.push('unknown route id shows empty state');

    await page.goto(`${base}/profile.html`);
    assert.equal(await page.locator('input[name="comfortFirst"]').isChecked(), true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await shot(page, 'profile-desktop');
    completed.push('profile restored, mobile and desktop layouts');

    const direct = await preparedHome(browser);
    let parseCalls = 0;
    direct.page.on('request', r => { if (r.url().endsWith('/api/conditions/parse')) parseCalls++; });
    const [directResponse] = await Promise.all([
      apiResponse(direct.page, '/api/routes'), direct.page.click('#search-button'),
    ]);
    assert.equal(directResponse.status(), 200);
    await direct.page.waitForURL('**/result.html');
    assert.equal(parseCalls, 0);
    completed.push('empty today skips parser and requests real routes');
    await direct.context.close();

    const failure = await preparedHome(browser);
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
    await failure.context.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    const report = { passed: completed.length, checks: completed,
      routeApi: { status: routeResponse.status(), count: result.routes.length, sameRoute: result.sameRoute,
        routes: result.routes.map(({ id, label, distanceM, ascentM, maxSlopePercent,
          gradeCoveragePercent, stairsCount, crosswalkCount, coordinates }) => ({
          id, label, distanceM, ascentM, maxSlopePercent, gradeCoveragePercent, stairsCount,
          crosswalkCount, coordinateCount: coordinates.length,
        })) },
      successfulResponses: 'real FastAPI/A only', errorInjection: 'NO_ROUTE display check only',
      pageErrors: errors, externalRequests, artifacts };
    await fs.writeFile(path.join(artifacts, 'browser-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

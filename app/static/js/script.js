/* 나란히: 프로필은 localStorage, 승인된 상태와 실제 경로만 sessionStorage. */
(() => {
  "use strict";
  const PROFILE_KEY = "naranhi.profile.v1";
  const TRIP_KEY = "naranhi.trip.v1";
  const CONDITION_LABELS = {
    suitcase: "캐리어 이용", stroller: "유모차 이용", injuredLeg: "다리 부상·통증",
    tired: "피곤함", avoidStairs: "계단 회피", allowDetour: "우회 허용",
  };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const byId = (id) => document.getElementById(id);
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const numbers = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
  const distances = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function message(id, text) {
    const target = byId(id);
    if (!target) return;
    target.textContent = text || "";
    target.hidden = !text;
  }

  function showWarnings(target, warnings) {
    if (!target) return;
    target.replaceChildren();
    target.hidden = !warnings.length;
    if (!warnings.length) return;
    const list = node("ul", "warning-list");
    warnings.forEach((warning) => list.append(node("li", "", warning)));
    target.append(list);
  }

  function readStorage(area, key) {
    try { return JSON.parse(window[area].getItem(key) || "null"); }
    catch (_) { return null; }
  }

  function writeStorage(area, key, value) {
    try { window[area].setItem(key, JSON.stringify(value)); }
    catch (_) { throw new Error("브라우저 저장 공간을 사용할 수 없습니다. 저장 설정을 확인하고 다시 시도해 주세요."); }
  }

  function validProfile(value) {
    return isObject(value) && ["allowed", "avoid", "blocked"].includes(value.stairs)
      && ["allowed", "avoid"].includes(value.crosswalks)
      && ["detourAllowed", "gentleSlope", "comfortFirst"].every((key) => typeof value[key] === "boolean");
  }

  function cleanProfile(value) {
    return { stairs: value.stairs, detourAllowed: value.detourAllowed, gentleSlope: value.gentleSlope,
      crosswalks: value.crosswalks, comfortFirst: value.comfortFirst };
  }

  function validLocation(value) {
    return isObject(value) && isNumber(value.lat) && Math.abs(value.lat) <= 90
      && isNumber(value.lng) && Math.abs(value.lng) <= 180;
  }

  function validToday(value) {
    return isObject(value) && Object.keys(value).every(
      (key) => own(CONDITION_LABELS, key) && typeof value[key] === "boolean",
    );
  }

  function validRoute(route) {
    const nullableNumber = (value) => value === null || (isNumber(value) && value >= 0);
    const nullableCount = (value) => value === null || (Number.isInteger(value) && value >= 0);
    return isObject(route) && ["id", "label", "reason"].every((key) => typeof route[key] === "string")
      && isNumber(route.distanceM) && route.distanceM >= 0
      && nullableNumber(route.ascentM) && nullableNumber(route.maxSlopePercent)
      && nullableCount(route.crosswalkCount) && Number.isInteger(route.stairsCount) && route.stairsCount >= 0
      && isNumber(route.gradeCoveragePercent) && route.gradeCoveragePercent >= 0 && route.gradeCoveragePercent <= 100
      && isStrings(route.warnings) && Array.isArray(route.coordinates) && route.coordinates.length >= 2
      && route.coordinates.every((point) => Array.isArray(point) && point.length === 2
        && isNumber(point[0]) && Math.abs(point[0]) <= 180 && isNumber(point[1]) && Math.abs(point[1]) <= 90);
  }

  function validResponse(value) {
    return isObject(value) && typeof value.requestId === "string" && typeof value.sameRoute === "boolean"
      && isStrings(value.warnings) && Array.isArray(value.routes) && value.routes.length >= 1 && value.routes.length <= 3
      && value.routes.every(validRoute) && new Set(value.routes.map((route) => route.id)).size === value.routes.length;
  }

  function readTrip() {
    const trip = readStorage("sessionStorage", TRIP_KEY);
    if (!isObject(trip) || !validProfile(trip.profile) || !validResponse(trip.response)
      || !validLocation(trip.start) || !validLocation(trip.end)) return null;
    if (own(trip, "approvedToday") && !validToday(trip.approvedToday)) return null;
    return trip;
  }

  async function postJson(path, body) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      let response;
      try {
        response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      } catch (_) { throw new Error("서버에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요."); }
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error("서버 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요."); }
      if (!response.ok) {
        const publicMessage = isObject(data) && isObject(data.error) && typeof data.error.message === "string"
          ? data.error.message : "요청을 처리하지 못했습니다. 입력을 확인하고 다시 시도해 주세요.";
        throw new Error(publicMessage);
      }
      return data;
    } finally { window.clearTimeout(timeout); }
  }

  function initProfile() {
    const form = byId("profile-form");
    if (!form) return;
    const checkbox = (name) => form.querySelector(`input[name="${name}"]`);
    const saved = readStorage("localStorage", PROFILE_KEY);
    if (validProfile(saved)) {
      checkbox("stairs").checked = saved.stairs !== "allowed";
      checkbox("gentleSlope").checked = saved.gentleSlope;
      checkbox("crosswalks").checked = saved.crosswalks === "avoid";
      checkbox("comfortFirst").checked = saved.comfortFirst;
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      message("form-error", "");
      const comfortFirst = checkbox("comfortFirst").checked;
      const profile = { stairs: checkbox("stairs").checked ? "avoid" : "allowed",
        gentleSlope: checkbox("gentleSlope").checked, crosswalks: checkbox("crosswalks").checked ? "avoid" : "allowed",
        comfortFirst, detourAllowed: comfortFirst };
      try {
        writeStorage("localStorage", PROFILE_KEY, profile);
        window.location.assign("/home.html");
      } catch (error) { message("form-error", error.message); }
    });
  }

  async function initHome() {
    const saved = readStorage("localStorage", PROFILE_KEY);
    if (!validProfile(saved)) { window.location.replace("/profile.html"); return; }
    const profile = cleanProfile(saved);
    const form = byId("route-form"), panel = byId("parse-panel"), textInput = byId("today-status");
    const startSelect = byId("start"), endSelect = byId("end");
    let places, pending = false, pendingParse = null, parsedText = null, approvedToday = null, approvedText = null;
    const changedConditions = new Map();

    function setPending(value, status) {
      pending = value;
      [form, panel].forEach((container) => container.querySelectorAll("button,input,textarea,select")
        .forEach((control) => { control.disabled = value; }));
      form.setAttribute("aria-busy", String(value));
      message("status-message", status || "");
    }

    function hidePanel() {
      panel.hidden = true;
      document.querySelector(".home")?.classList.remove("is-confirming");
    }

    function selectedPlaces() {
      const start = places.find((place) => place.id === startSelect.value);
      const end = places.find((place) => place.id === endSelect.value);
      if (!start || !end || start.id === end.id) throw new Error("출발지와 도착지를 서로 다르게 선택해 주세요.");
      return { start, end };
    }

    function showParse(parsed) {
      changedConditions.clear();
      message("parse-terms", parsed.recognizedTerms.length ? `인식한 표현: ${parsed.recognizedTerms.join(", ")}` : "인식한 표현이 없습니다.");
      message("parser-method", "규칙 기반 분석 · 자동 분석은 틀릴 수 있어요. 상태를 확인하고 적용해 주세요.");
      showWarnings(byId("parse-warning"), parsed.warnings);
      const container = byId("parse-conditions");
      container.replaceChildren();
      Object.entries(CONDITION_LABELS).forEach(([key, labelText]) => {
        const label = node("label", "parse-condition"), input = node("input");
        input.type = "checkbox";
        input.name = key;
        const recognized = own(parsed.today, key);
        input.checked = recognized && parsed.today[key];
        input.indeterminate = !recognized;
        const state = node("span", "condition-state", recognized ? (parsed.today[key] ? "예로 분석" : "아니요로 분석") : "미인식 · 변경하지 않으면 요청에서 제외");
        input.addEventListener("change", () => {
          changedConditions.set(key, input.checked);
          state.textContent = input.checked ? "직접 선택: 예" : "직접 선택: 아니요";
        });
        label.append(input, node("span", "condition-label", labelText), state);
        container.append(label);
      });
      panel.hidden = false;
      document.querySelector(".home")?.classList.add("is-confirming");
    }

    async function analyze() {
      const text = textInput.value.trim();
      if (!text) throw new Error("오늘 상태를 입력해 주세요. 상태가 없으면 바로 길찾기를 눌러 주세요.");
      approvedToday = null;
      approvedText = null;
      pendingParse = null;
      parsedText = null;
      hidePanel();
      setPending(true, "오늘 상태를 분석하고 있어요.");
      try {
        const parsed = await postJson("/api/conditions/parse", { text });
        if (!isObject(parsed) || !validToday(parsed.today) || !isStrings(parsed.recognizedTerms)
          || !isStrings(parsed.warnings) || parsed.requiresConfirmation !== true || parsed.parserMethod !== "rules") {
          throw new Error("분석 응답 형식을 확인하지 못했습니다. 다시 입력해 주세요.");
        }
        pendingParse = parsed;
        parsedText = text;
        showParse(parsed);
      } finally { setPending(false); }
      byId("parse-confirm-button").focus();
    }

    async function requestRoutes(today) {
      const { start, end } = selectedPlaces();
      const body = { start: { lat: start.lat, lng: start.lng }, end: { lat: end.lat, lng: end.lng }, profile };
      if (today !== null) body.today = { ...today };
      setPending(true, "실제 보행 데이터로 경로를 찾고 있어요.");
      try {
        const response = await postJson("/api/routes", body);
        if (!validResponse(response)) throw new Error("경로 응답 형식을 확인하지 못했습니다. 다시 시도해 주세요.");
        const trip = { start, end, profile, response, selectedRouteId: response.routes[0].id };
        if (today !== null) trip.approvedToday = { ...today };
        writeStorage("sessionStorage", TRIP_KEY, trip);
        window.location.assign("/result.html");
      } finally { setPending(false); }
    }

    setPending(true, "시연용 출발지와 도착지를 불러오고 있어요.");
    try {
      const response = await fetch("/static/data/demo-places.json", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("장소 목록을 불러오지 못했습니다.");
      places = await response.json();
      if (!Array.isArray(places) || places.length < 2 || !places.every((place) => validLocation(place)
        && typeof place.id === "string" && typeof place.name === "string")) throw new Error("장소 목록을 확인하지 못했습니다.");
      const previousTrip = readTrip();
      [startSelect, endSelect].forEach((select) => {
        select.replaceChildren();
        places.forEach((place) => { const option = node("option", "", place.name); option.value = place.id; select.append(option); });
      });
      startSelect.value = places.some((place) => place.id === previousTrip?.start?.id) ? previousTrip.start.id : places[0].id;
      endSelect.value = places.some((place) => place.id === previousTrip?.end?.id) ? previousTrip.end.id : places[1].id;
    } catch (_) {
      message("form-error", "시연 장소 목록을 불러오지 못했습니다. 연결을 확인하고 새로고침해 주세요.");
      message("status-message", "");
      return;
    }
    setPending(false);

    async function handle(action) {
      if (pending) return;
      message("form-error", "");
      try { await action(); } catch (error) { message("form-error", error.message); }
    }

    byId("parse-button").addEventListener("click", () => handle(analyze));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      handle(async () => {
        selectedPlaces();
        const text = textInput.value.trim();
        if (!text) await requestRoutes(null);
        else if (approvedText === text && approvedToday !== null) await requestRoutes(approvedToday);
        else await analyze();
      });
    });
    byId("parse-edit-button").addEventListener("click", () => { hidePanel(); textInput.focus(); });
    byId("parse-confirm-button").addEventListener("click", () => handle(async () => {
      if (!pendingParse || parsedText !== textInput.value.trim()) throw new Error("입력 내용이 바뀌었습니다. 다시 분석하고 확인해 주세요.");
      approvedToday = { ...pendingParse.today };
      changedConditions.forEach((value, key) => { approvedToday[key] = value; });
      approvedText = parsedText;
      await requestRoutes(approvedToday);
    }));
    textInput.addEventListener("input", () => {
      approvedToday = null;
      approvedText = null;
      pendingParse = null;
      parsedText = null;
      hidePanel();
    });
  }

  function distance(value) {
    return value >= 1000 ? `${distances.format(value / 1000)}km` : `${numbers.format(value)}m`;
  }

  function appendMetrics(card, route) {
    const main = node("p", "route-main"), distanceSpan = node("span", "route-distance", distance(route.distanceM));
    distanceSpan.dataset.field = "distanceM";
    main.append(distanceSpan);
    card.append(main);
    const list = node("ul", "route-stats");
    [
      ["누적 상승", "ascentM", "m", "stat-ascent"],
      ["최대 경사", "maxSlopePercent", "%", "stat-slope"],
      ["경사 데이터 확인율", "gradeCoveragePercent", "%", "stat-coverage"],
      ["확인된 계단", "stairsCount", "개", "stat-stairs"],
      ["횡단 횟수", "crosswalkCount", "회", "stat-crosswalks"],
    ].forEach(([label, field, unit, className]) => {
      const value = route[field], item = node("li", "", label);
      const span = node("span", className + (value === null ? " is-unknown" : ""), value === null ? "정보 미확인" : `${numbers.format(value)}${unit}`);
      span.dataset.field = field;
      item.append(span);
      list.append(item);
    });
    card.append(list, node("p", "route-reason", route.reason));
    if (route.stairsCount === 0) card.append(node("p", "note", "확인된 계단 0개가 무장애 경로를 보장하지는 않습니다."));
    const warnings = node("ul", "route-warnings");
    route.warnings.forEach((warning) => warnings.append(node("li", "", warning)));
    warnings.hidden = !route.warnings.length;
    card.append(warnings);
  }

  function appendRouteExplanations(card, route, trip) {
    const build = window.NaranhiRouteExplanations?.buildRoutePresentation;
    if (typeof build !== "function") return;
    const presentation = build(route, trip.response.routes, trip);
    const header = node("header", "route-card-header");
    const heading = node("div", "route-heading");
    heading.append(card.querySelector(".route-number"), card.querySelector(".route-label"));
    header.append(heading, node("span", "route-type-badge", presentation.badge));
    card.prepend(header);
    const main = card.querySelector(".route-main");
    header.after(main);
    const section = node("section", "route-explanations");
    section.dataset.routeId = route.id;
    section.append(node("h3", "explanation-title visually-hidden", "경로 비교와 요청 조건"));
    if (presentation.displayFacts.length) {
      const facts = node("ul", "explanation-facts");
      presentation.displayFacts.forEach((text) => facts.append(node("li", "", text)));
      section.append(facts);
    }
    if (presentation.fallback) section.append(node("p", "explanation-fallback", presentation.reference
      ? "비교 가능한 수치에 표시할 차이가 없어 기본 추천 이유를 함께 안내해요."
      : "비교할 다른 경로가 없어 기본 추천 이유를 안내해요."));
    section.append(node("p", "explanation-summary", presentation.summary));
    if (presentation.slope) {
      const slope = node("div", "explanation-slope");
      slope.append(node("p", "slope-preference", presentation.slope.summary));
      if (presentation.slope.caution) slope.append(node("p", "slope-caution", presentation.slope.caution));
      section.append(slope);
    }
    const conditions = node("div", "explanation-conditions");
    conditions.append(node("h4", "keyword-heading", "적용한 이동 조건"));
    if (presentation.keywords.length) {
      const keywords = node("ul", "condition-keywords");
      keywords.setAttribute("aria-label", "이번 검색에 적용한 이동 조건");
      presentation.keywords.forEach(({ key, label }) => {
        const keyword = node("li", "condition-keyword", label);
        keyword.dataset.condition = key;
        keywords.append(keyword);
      });
      conditions.append(keywords);
    } else conditions.append(node("p", "keyword-empty", "추가 조건 없음"));
    section.append(conditions);
    const data = node("div", "explanation-uncertainties");
    data.append(node("h4", "", "데이터 안내"));
    const notes = node("ul");
    presentation.dataNotes.forEach((text) => notes.append(node("li", "", text)));
    data.append(notes);
    section.append(data);
    main.after(section);
    const preview = card.querySelector(".route-preview-link");
    if (preview) header.after(preview);
    card.querySelector(".route-reason").before(node("h3", "reason-heading", "기본 추천 이유"));
  }
  function showEmpty(text) {
    ["routes-container", "route-detail", "route-map", "choose-route-button", "selected-status", "global-warnings", "same-route-message"].forEach((id) => {
      if (byId(id)) byId(id).hidden = true;
    });
    const empty = byId("empty-state");
    if (empty) {
      empty.hidden = false;
      const home = node("a", "btn-primary", "홈에서 경로 찾기");
      home.href = "/home.html";
      empty.replaceChildren(node("p", "", text), home);
    }
  }

  function renderSummary(trip) {
    message("trip-summary", `${trip.start.name || "출발지"} → ${trip.end.name || "도착지"}`);
    showWarnings(byId("global-warnings"), trip.response.warnings);
  }

  function initResult() {
    const trip = readTrip();
    if (!trip) return showEmpty("이 탭에 저장된 경로가 없습니다. 홈에서 실제 경로를 요청해 주세요.");
    renderSummary(trip);
    message("same-route-message", trip.response.sameRoute ? "맞춤 추천과 최단 경로가 같습니다. 아래 대안 경로가 있다면 함께 확인할 수 있어요." : "맞춤 추천과 최단 경로가 서로 다릅니다.");
    const container = byId("routes-container");
    container.replaceChildren();
    if (!trip.response.routes.some((route) => route.id === trip.selectedRouteId)) trip.selectedRouteId = trip.response.routes[0].id;
    const cards = [];
    function select(id) {
      trip.selectedRouteId = id;
      writeStorage("sessionStorage", TRIP_KEY, trip);
      cards.forEach((card) => {
        const selected = card.dataset.routeId === id;
        card.classList.toggle("is-selected", selected);
        card.setAttribute("aria-checked", String(selected));
        card.tabIndex = selected ? 0 : -1;
      });
    }
    trip.response.routes.forEach((route, index) => {
      const card = node("article", "route-card" + (index === 0 ? " is-recommended" : ""));
      card.dataset.routeId = route.id;
      card.setAttribute("role", "radio");
      card.append(node("p", "route-number", `${index + 1}번 경로`));
      card.append(node("h2", "route-label", route.label));
      const preview = node("a", "route-preview-link");
      preview.href = `/route.html?routeId=${encodeURIComponent(route.id)}`;
      preview.setAttribute("aria-label", `${route.label} 경로 미리보기, 실제 지도 보기`);
      const diagram = node("div", "route-map route-preview");
      diagram.setAttribute("aria-hidden", "true");
      renderCoordinateMap(diagram, route.coordinates);
      preview.append(diagram, node("span", "preview-caption", "실제 경로 미리보기 · 눌러서 지도 보기"));
      preview.addEventListener("click", (event) => {
        try { select(route.id); } catch (error) { event.preventDefault(); message("form-error", error.message); }
      });
      card.append(preview);
      appendMetrics(card, route);
      appendRouteExplanations(card, route, trip);
      const link = node("a", "route-link", "이 경로 보기 →");
      link.href = `/route.html?routeId=${encodeURIComponent(route.id)}`;
      link.addEventListener("click", (event) => {
        try { select(route.id); } catch (error) { event.preventDefault(); message("form-error", error.message); }
      });
      card.append(link);
      card.addEventListener("click", (event) => {
        if (event.target.closest("a")) return;
        try { select(route.id); } catch (error) { message("form-error", error.message); }
      });
      card.addEventListener("keydown", (event) => {
        if (event.target.closest("a")) return;
        let nextIndex = index;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % cards.length;
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index + cards.length - 1) % cards.length;
        else if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        try { select(cards[nextIndex].dataset.routeId); cards[nextIndex].focus(); }
        catch (error) { message("form-error", error.message); }
      });
      cards.push(card);
      container.append(card);
    });
    select(trip.selectedRouteId);
  }

  function renderCoordinateMap(container, coordinates) {
    const namespace = "http://www.w3.org/2000/svg";
    const makeSvg = (tag, attributes) => {
      const element = document.createElementNS(namespace, tag);
      Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
      return element;
    };
    const centerLat = coordinates.reduce((sum, point) => sum + point[1], 0) / coordinates.length;
    const cosLat = Math.max(Math.cos(centerLat * Math.PI / 180), 0.00001);
    const projected = coordinates.map(([lng, lat]) => [lng * cosLat, lat]);
    const xs = projected.map((point) => point[0]), ys = projected.map((point) => point[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const width = 640, height = 360, padding = 42, spanX = maxX - minX, spanY = maxY - minY;
    const scale = Math.min((width - padding * 2) / (spanX || 0.000000001), (height - padding * 2) / (spanY || 0.000000001));
    const offsetX = (width - spanX * scale) / 2, offsetY = (height - spanY * scale) / 2;
    const points = projected.map(([x, y]) => [offsetX + (x - minX) * scale, height - offsetY - (y - minY) * scale]);
    const svg = makeSvg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "실제 경로 좌표도. 배경지도는 포함하지 않습니다.", width: "100%" });
    const title = makeSvg("title", {});
    title.textContent = "실제 경로 좌표도 · 배경지도 미포함";
    svg.append(title, makeSvg("rect", { width, height, fill: "#f3f8f4", rx: 16 }));
    svg.append(makeSvg("polyline", { points: points.map((point) => point.join(",")).join(" "), fill: "none", stroke: "#287c52", "stroke-width": 5, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    [[0, "출발", "#287c52"], [points.length - 1, "도착", "#ad3d57"]].forEach(([index, label, color]) => {
      const [x, y] = points[index];
      const marker = makeSvg("circle", { cx: x, cy: y, r: 8, fill: color, stroke: "white", "stroke-width": 2 });
      const text = makeSvg("text", { x, y: y - 14, "text-anchor": "middle", fill: color, "font-size": 15 });
      text.textContent = label;
      svg.append(marker, text);
    });
    container.replaceChildren(svg);
  }

  // ZIP의 지도 코드에서 좌표 변환·경로선·끝점 마커만 선별했습니다.
  // result/check는 SVG를 사용하며, Leaflet은 route에서만 초기화합니다.
  function renderRouteMap(container, trip, selectedRoute) {
    const leaflet = window.L;
    const stylesheet = document.querySelector("link[data-leaflet-css]");
    const unavailable = "지도를 불러오지 못했습니다. 연결을 확인하거나 경로 비교의 미리보기를 이용해 주세요. 아래 경로 정보는 계속 확인할 수 있습니다.";
    if (!leaflet || leaflet.version !== "1.9.4" || !stylesheet?.sheet) {
      container.hidden = true;
      message("map-warning", unavailable);
      return;
    }
    let map;
    try {
      container.hidden = false;
      map = leaflet.map(container, { scrollWheelZoom: false });
      const tiles = leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      });
      tiles.on("tileerror", () => message("map-warning", "배경지도를 불러오지 못한 구간이 있습니다. 경로선과 아래 정보를 확인해 주세요."));
      tiles.addTo(map);
      const palette = ["#287c52", "#386ec2", "#a76a22"];
      let selectedLine;
      trip.response.routes.forEach((route, index) => {
        const selected = route.id === selectedRoute.id;
        // API [경도, 위도]를 Leaflet [위도, 경도]로 변환합니다.
        const points = route.coordinates.map(([lng, lat]) => [lat, lng]);
        const line = leaflet.polyline(points, {
          color: palette[index], weight: selected ? 7 : 3,
          opacity: selected ? 1 : 0.45, dashArray: selected ? null : "8 7",
          className: "route-line" + (selected ? " route-line--selected" : ""),
        }).addTo(map);
        line.bindTooltip(node("span", "", route.label));
        if (selected) selectedLine = line;
      });
      const points = selectedRoute.coordinates.map(([lng, lat]) => [lat, lng]);
      [[points[0], "출발 · 보행 노드", "#287c52"],
        [points[points.length - 1], "도착 · 보행 노드", "#ad3d57"]].forEach(([point, label, color]) => {
        leaflet.circleMarker(point, { radius: 8, color: "#ffffff", weight: 2,
          fillColor: color, fillOpacity: 1 }).addTo(map)
          .bindTooltip(node("span", "", label), { permanent: true, direction: "top", offset: [0, -8] });
      });
      map.fitBounds(leaflet.latLngBounds(points), { padding: [32, 32], maxZoom: 18 });
      selectedLine.bringToFront();
      window.requestAnimationFrame(() => map.invalidateSize({ pan: false }));
    } catch (_) {
      if (map) map.remove();
      container.replaceChildren();
      container.hidden = true;
      message("map-warning", unavailable);
    }
  }

  function initDetail(page) {
    const trip = readTrip();
    if (!trip) return showEmpty("표시할 경로가 없습니다. 홈에서 경로를 다시 요청해 주세요.");
    const requestedId = new URLSearchParams(window.location.search).get("routeId");
    const routeId = requestedId === null ? trip.selectedRouteId : requestedId;
    const route = trip.response.routes.find((item) => item.id === routeId);
    if (!route) return showEmpty("선택한 경로를 찾을 수 없습니다. 홈에서 다시 경로를 요청해 주세요.");
    trip.selectedRouteId = route.id;
    writeStorage("sessionStorage", TRIP_KEY, trip);
    renderSummary(trip);
    const card = node("article", "route-card");
    if (page === "route") card.append(node("p", "route-number", `${trip.response.routes.findIndex((item) => item.id === route.id) + 1}번 경로`));
    card.append(node("h2", "route-label", route.label));
    appendMetrics(card, route);
    if (page === "route") {
      appendRouteExplanations(card, route, trip);
      const checkLink = node("a", "route-link", "정보 미확인·주의사항 확인 →");
      checkLink.href = `/check.html?routeId=${encodeURIComponent(route.id)}`;
      card.append(checkLink);
    }
    byId("route-detail").replaceChildren(card);
    if (page === "route") renderRouteMap(byId("route-map"), trip, route);
    else renderCoordinateMap(byId("route-map"), route.coordinates);
    const choose = byId("choose-route-button");
    if (choose) choose.addEventListener("click", () => {
      try {
        writeStorage("sessionStorage", TRIP_KEY, trip);
        message("selected-status", "이 경로를 선택했습니다. 선택은 이 탭에만 반영되며 실시간 길안내는 제공하지 않습니다.");
      } catch (error) { message("form-error", error.message); }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      const page = document.body.dataset.page;
      if (page === "profile") initProfile();
      else if (page === "home") await initHome();
      else if (page === "result") initResult();
      else if (page === "route" || page === "check") initDetail(page);
    } catch (_) {
      message("form-error", "화면을 준비하지 못했습니다. 홈에서 다시 시도해 주세요.");
      showEmpty("화면을 준비하지 못했습니다. 홈에서 다시 시도해 주세요.");
    }
  });
})();

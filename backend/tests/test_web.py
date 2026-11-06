"""FastAPI 단일 서버의 HTML·정적 파일·실제 API 연동 HTTP 검증."""

from html.parser import HTMLParser
from itertools import permutations
import json
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
import route_service_v02 as route_service  # noqa: E402
import uvicorn  # noqa: E402


LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
LEAFLET_CSS_INTEGRITY = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
LEAFLET_JS_INTEGRITY = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="


EXPECTED_DEMO_PLACES = [
    {"id": "duksung_gate", "name": "덕성여대 정문", "lat": 37.6517, "lng": 127.0149},
    {"id": "hyomun_gate", "name": "효문중고 출입구", "lat": 37.6526, "lng": 127.0174},
    {"id": "duksung_dorm", "name": "덕성여대 기숙사",
     "lat": 37.6491330337407, "lng": 127.022277801401},
    {"id": "april19_station_exit1", "name": "4·19민주묘지역 1번 출구",
     "lat": 37.649707, "lng": 127.013733},
]


class PageElements(HTMLParser):
    def __init__(self):
        super().__init__()
        self.body_page = None
        self.scripts = []
        self.stylesheets = []
        self.resources = []
        self.links = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "body":
            self.body_page = attrs.get("data-page")
        if tag == "script":
            self.scripts.append(attrs)
        if tag in ("script", "img") and attrs.get("src"):
            self.resources.append(attrs["src"])
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.stylesheets.append(attrs)
            self.resources.append(attrs.get("href", ""))
        elif tag == "link" and attrs.get("href", "").startswith("/static/"):
            self.resources.append(attrs["href"])
        if tag == "a" and attrs.get("href"):
            self.links.append(attrs["href"])


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        return None


class WebServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        cls.sock.bind(("127.0.0.1", 0))
        cls.sock.listen(128)
        cls.base_url = f"http://127.0.0.1:{cls.sock.getsockname()[1]}"
        cls.server = uvicorn.Server(
            uvicorn.Config(
                main.app, log_level="critical", access_log=False,
                lifespan="off", proxy_headers=False,
            )
        )
        cls.thread = threading.Thread(
            target=cls.server.run, kwargs={"sockets": [cls.sock]}, daemon=True,
        )
        cls.addClassCleanup(cls.stop_server)
        cls.thread.start()
        deadline = time.monotonic() + 10
        while not cls.server.started:
            if not cls.thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("통합 화면 테스트 서버를 시작하지 못했습니다.")
            time.sleep(0.01)
        cls.opener = build_opener(ProxyHandler({}))
        cls.no_redirect = build_opener(ProxyHandler({}), NoRedirect())

    @classmethod
    def stop_server(cls):
        cls.server.should_exit = True
        cls.thread.join(timeout=10)
        cls.sock.close()
        if cls.thread.is_alive():
            raise RuntimeError("통합 화면 테스트 서버가 종료되지 않았습니다.")

    def request(self, path, method="GET", payload=None, follow=True):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            self.base_url + path, data=data, method=method,
            headers={"Content-Type": "application/json", "Connection": "close"},
        )
        try:
            response = (self.opener if follow else self.no_redirect).open(request, timeout=10)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, response.headers, response.read()

    def assert_error(self, path, method="GET", expected=404):
        status, headers, body = self.request(path, method)
        self.assertEqual(status, expected)
        self.assertEqual(headers.get_content_type(), "application/json")
        error = json.loads(body)
        self.assertEqual(set(error), {"error"})
        self.assertEqual(set(error["error"]), {"code", "message"})

    def test_root_redirects_to_home(self):
        status, headers, _ = self.request("/", follow=False)
        self.assertEqual(status, 307)
        self.assertEqual(headers["Location"], "/home.html")
        status, _, body = self.request("/")
        self.assertEqual(status, 200)
        parser = PageElements()
        parser.feed(body.decode("utf-8"))
        self.assertEqual(parser.body_page, "home")

    def test_five_pages_use_local_shared_script_and_valid_static_resources(self):
        resources = set()
        for page in ("profile", "home", "result", "route", "check"):
            with self.subTest(page=page):
                status, headers, body = self.request(f"/{page}.html")
                self.assertEqual(status, 200)
                self.assertEqual(headers.get_content_type(), "text/html")
                self.assertEqual(headers["Cache-Control"], "no-store")
                parser = PageElements()
                parser.feed(body.decode("utf-8"))
                self.assertEqual(parser.body_page, page)
                expected_scripts = ["/static/js/script.js"]
                expected_stylesheets = ["/static/css/style.css"]
                approved_external = set()
                if page == "route":
                    expected_scripts.insert(0, LEAFLET_JS)
                    expected_stylesheets.insert(0, LEAFLET_CSS)
                    approved_external = {LEAFLET_CSS, LEAFLET_JS}
                self.assertEqual(
                    [script.get("src") for script in parser.scripts], expected_scripts,
                )
                self.assertEqual(
                    [style.get("href") for style in parser.stylesheets],
                    expected_stylesheets,
                )
                for script in parser.scripts:
                    self.assertIn("defer", script)
                    self.assertNotIn("async", script)
                if page == "route":
                    for asset, integrity in (
                        (parser.stylesheets[0], LEAFLET_CSS_INTEGRITY),
                        (parser.scripts[0], LEAFLET_JS_INTEGRITY),
                    ):
                        self.assertEqual(asset.get("integrity"), integrity)
                        self.assertEqual(asset.get("crossorigin"), "anonymous")
                for resource in parser.resources:
                    if resource.startswith("/static/"):
                        resources.add(resource)
                    else:
                        self.assertIn(resource, approved_external)
                for link in parser.links:
                    if not link.startswith("#"):
                        self.assertTrue(link.startswith("/"), link)
                # CDN assets are pinned above. HTTP checks remain local and
                # deterministic; real loading is covered by browser tests.
        for resource in resources:
            with self.subTest(resource=resource):
                status, _, _ = self.request(resource)
                self.assertEqual(status, 200)

    def test_rendered_pages_do_not_present_invented_route_metrics_or_sample_map(self):
        for page in ("home", "result", "route", "check"):
            with self.subTest(page=page):
                status, _, body = self.request(f"/{page}.html")
                self.assertEqual(status, 200)
                html = body.decode("utf-8")
                for stale in ("18분", "14분", "1.1km", "850m", "map-demo.svg", "_aistudio-iframe"):
                    self.assertNotIn(stale, html)
                self.assertNotIn("jquery", html.lower())

    def test_demo_coordinates_are_the_four_locations(self):
        status, headers, body = self.request("/static/data/demo-places.json")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "application/json")
        places = json.loads(body)
        # Keep the existing two IDs/order, exact names and supplied precision.
        # The station exit must not be relabeled as the cemetery entrance.
        self.assertEqual(places, EXPECTED_DEMO_PLACES)

    def test_all_demo_place_directions_and_conditions_match_real_routes(self):
        status, _, body = self.request("/static/data/demo-places.json")
        self.assertEqual(status, 200)
        places = json.loads(body)
        self.assertEqual(places, EXPECTED_DEMO_PLACES)
        conditions = (
            ("normal", None),
            ("suitcase", {"suitcase": True}),
            ("stroller", {"stroller": True}),
        )
        cases = 0
        new_pair_cases = 0
        for start, end in permutations(places, 2):
            for condition, today in conditions:
                cases += 1
                with self.subTest(
                    start=start["id"], end=end["id"], condition=condition,
                ):
                    payload = {
                        "start": {key: start[key] for key in ("lat", "lng")},
                        "end": {key: end[key] for key in ("lat", "lng")},
                        "profile": {"stairs": "allowed"},
                    }
                    if today is not None:
                        payload["today"] = today.copy()
                    expected = route_service.recommend_routes(payload)
                    status, headers, body = self.request("/api/routes", "POST", payload)
                    self.assertEqual(status, 200)
                    self.assertEqual(headers.get_content_type(), "application/json")
                    actual = json.loads(body)
                    self.assertEqual(
                        {key: value for key, value in actual.items() if key != "requestId"},
                        {key: value for key, value in expected.items() if key != "requestId"},
                    )
                    self.assertGreaterEqual(len(actual["routes"]), 1)
                    self.assertLessEqual(len(actual["routes"]), 3)
                    self.assertIsInstance(actual["sameRoute"], bool)
                    if condition == "stroller":
                        self.assertTrue(
                            all(route["stairsCount"] == 0 for route in actual["routes"])
                        )
                    if {start["id"], end["id"]} == {
                        "duksung_dorm", "april19_station_exit1",
                    }:
                        new_pair_cases += 1
                        primary = actual["routes"][0]
                        # A's verified representative route is the same for
                        # these six cases. Do not assume symmetry for all pairs.
                        self.assertEqual(primary["distanceM"], 1121.3)
                        self.assertEqual(len(primary["coordinates"]), 53)
                        self.assertEqual(primary["stairsCount"], 0)
                        self.assertEqual(primary["gradeCoveragePercent"], 19.7)
                        self.assertIs(actual["sameRoute"], True)
                        for field in ("ascentM", "maxSlopePercent", "crosswalkCount"):
                            self.assertIsNone(primary[field])
        self.assertEqual(cases, 36)
        self.assertEqual(new_pair_cases, 6)

    def test_unknown_pages_and_traversal_do_not_expose_backend_files(self):
        for path in (
            "/unknown.html", "/backend/nodes.json", "/docs/example_input.json",
            "/static/../backend/nodes.json", "/static/%2e%2e/%2e%2e/backend/main.py",
            "/static/.git/config",
        ):
            with self.subTest(path=path):
                self.assert_error(path)
        self.assert_error("/result.html", method="POST", expected=405)

    def test_web_routes_do_not_change_api_openapi_contract(self):
        status, _, body = self.request("/openapi.json")
        self.assertEqual(status, 200)
        self.assertEqual(
            set(json.loads(body)["paths"]),
            {"/health", "/api/routes", "/api/conditions/parse"},
        )

    def test_real_parse_and_routes_work_on_the_same_server(self):
        status, _, body = self.request(
            "/api/conditions/parse", "POST", {"text": "캐리어가 있어요"},
        )
        self.assertEqual(status, 200)
        parsed = json.loads(body)
        self.assertEqual(parsed["today"], {"suitcase": True})
        self.assertIs(parsed["requiresConfirmation"], True)
        self.assertEqual(parsed["parserMethod"], "rules")
        request = json.loads((REPO_DIR / "docs/example_input.json").read_text(encoding="utf-8"))
        request["today"] = parsed["today"]
        expected = route_service.recommend_routes(request)
        status, _, body = self.request("/api/routes", "POST", request)
        self.assertEqual(status, 200)
        actual = json.loads(body)
        self.assertEqual(
            {key: value for key, value in actual.items() if key != "requestId"},
            {key: value for key, value in expected.items() if key != "requestId"},
        )


if __name__ == "__main__":
    unittest.main()

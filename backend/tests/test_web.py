"""FastAPI 단일 서버의 HTML·정적 파일·실제 API 연동 HTTP 검증."""

from html.parser import HTMLParser
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


class PageElements(HTMLParser):
    def __init__(self):
        super().__init__()
        self.body_page = None
        self.scripts = []
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
        if tag == "link" and attrs.get("href", "").startswith("/static/"):
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
                self.assertEqual(len(parser.scripts), 1)
                self.assertEqual(parser.scripts[0].get("src"), "/static/js/script.js")
                self.assertIn("defer", parser.scripts[0])
                for resource in parser.resources:
                    self.assertTrue(resource.startswith("/static/"), resource)
                for link in parser.links:
                    if not link.startswith("#"):
                        self.assertTrue(link.startswith("/"), link)
                resources.update(parser.resources)
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

    def test_demo_coordinates_are_the_verified_two_locations(self):
        status, headers, body = self.request("/static/data/demo-places.json")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "application/json")
        places = json.loads(body)
        if isinstance(places, dict):
            places = places.get("places", places)
        if isinstance(places, dict):
            places = list(places.values())
        self.assertEqual(len(places), 2)
        self.assertEqual(
            {(place["lat"], place["lng"]) for place in places},
            {(37.6517, 127.0149), (37.6526, 127.0174)},
        )

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

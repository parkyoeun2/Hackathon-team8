"""상태 분석 API를 실제 로컬 HTTP로 검증합니다."""

import json
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import conditions_api  # noqa: E402
import main  # noqa: E402
import uvicorn  # noqa: E402


class ConditionsApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        cls.sock.bind(("127.0.0.1", 0))
        cls.sock.listen(128)
        cls.base_url = f"http://127.0.0.1:{cls.sock.getsockname()[1]}"
        cls.server = uvicorn.Server(
            uvicorn.Config(
                main.app,
                log_level="critical",
                access_log=False,
                lifespan="off",
                proxy_headers=False,
            )
        )
        cls.thread = threading.Thread(
            target=cls.server.run, kwargs={"sockets": [cls.sock]}, daemon=True
        )
        cls.addClassCleanup(cls.stop_server)
        cls.thread.start()
        deadline = time.monotonic() + 10
        while not cls.server.started:
            if not cls.thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("상태 분석 테스트 서버를 시작하지 못했습니다.")
            time.sleep(0.01)
        cls.opener = build_opener(ProxyHandler({}))

    @classmethod
    def stop_server(cls):
        cls.server.should_exit = True
        cls.thread.join(timeout=10)
        cls.sock.close()
        if cls.thread.is_alive():
            raise RuntimeError("상태 분석 테스트 서버가 종료되지 않았습니다.")

    def request(self, payload=None, *, raw=None, path="/api/conditions/parse", method="POST"):
        if raw is None and payload is not None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = Request(
            self.base_url + path,
            data=raw,
            headers={"Content-Type": "application/json", "Connection": "close"},
            method=method,
        )
        try:
            response = self.opener.open(request, timeout=10)
        except HTTPError as exc:
            response = exc
        with response:
            self.assertEqual(response.headers.get_content_type(), "application/json")
            return response.status, json.loads(response.read().decode("utf-8"))

    def assert_result(self, text, expected):
        status, body = self.request({"text": text})
        self.assertEqual(status, 200)
        self.assertEqual(body["today"], expected)
        self.assertEqual(
            set(body),
            {"today", "recognizedTerms", "warnings", "requiresConfirmation", "parserMethod"},
        )
        self.assertIs(body["requiresConfirmation"], True)
        self.assertEqual(body["parserMethod"], "rules")
        self.assertTrue(all(type(value) is bool for value in body["today"].values()))
        return body

    def assert_error(self, status, body, expected_status, code):
        self.assertEqual(status, expected_status)
        self.assertEqual(set(body), {"error"})
        self.assertEqual(set(body["error"]), {"code", "message"})
        self.assertEqual(body["error"]["code"], code)
        self.assertTrue(body["error"]["message"])

    def test_multiple_conditions_and_explicit_negation_over_http(self):
        self.assert_result(
            "캐리어가 있어요. 유모차를 끌고 있어요. 다리를 다쳤어요. "
            "피곤해요. 계단은 피하고 싶어요. 조금 돌아가도 괜찮아요.",
            {key: True for key in (
                "suitcase", "stroller", "injuredLeg", "tired", "avoidStairs", "allowDetour"
            )},
        )
        for text, expected in (
            ("캐리어 없어요", {"suitcase": False}),
            ("유모차를 안 끌어요", {"stroller": False}),
            ("다리 안 다쳤어요", {"injuredLeg": False}),
            ("계단 피할 필요 없어요", {"avoidStairs": False}),
            ("캐리어는 없고 유모차는 있어요", {"suitcase": False, "stroller": True}),
            ("피곤하지만 캐리어는 없어요", {"tired": True, "suitcase": False}),
        ):
            with self.subTest(text=text):
                self.assert_result(text, expected)

    def test_unknown_ambiguous_and_conflicting_input_requires_confirmation(self):
        for text in (
            "오늘은 날씨가 좋아요",
            "캐리어 있을 수도 있어요",
            "캐리어는 없지만 캐리어가 있어요",
        ):
            with self.subTest(text=text):
                body = self.assert_result(text, {})
                self.assertTrue(body["warnings"])

    def test_whitespace_excluded_length_boundary(self):
        for text in ("가" * 500, "가 \t" * 500):
            with self.subTest(length=len(text)):
                status, body = self.request({"text": text})
                self.assertEqual(status, 200)
                self.assertEqual(body["today"], {})
        for text in ("", " \t\r\n", "가" * 501, "가 " * 501):
            with self.subTest(length=len(text)):
                self.assert_error(*self.request({"text": text}), 422, "INVALID_TEXT")

    def test_invalid_request_shapes_and_unknown_fields_use_invalid_text(self):
        for payload in (
            {}, {"text": None}, {"text": 1}, {"text": True},
            {"text": []}, {"text": {}}, [],
            {"text": "캐리어가 있어요", "profile": {"stairs": "allowed"}},
            {"text": "캐리어가 있어요", "umbrella": True},
        ):
            with self.subTest(payload=payload):
                self.assert_error(*self.request(payload), 422, "INVALID_TEXT")
        for raw in (b"{", b"null", b"", b'{"text":"\xff"}'):
            with self.subTest(raw=raw):
                self.assert_error(*self.request(raw=raw), 422, "INVALID_TEXT")

    def test_raw_text_and_internal_error_are_not_returned_or_logged(self):
        secret = "캐리어가 있어요. 비공개원문표식123456입니다."
        body = self.assert_result(secret, {"suitcase": True})
        self.assertNotIn(secret, json.dumps(body, ensure_ascii=False))
        self.assertNotIn("비공개원문표식123456", json.dumps(body, ensure_ascii=False))
        with (
            self.assertNoLogs("conditions_api", level="DEBUG"),
            self.assertNoLogs("uvicorn.error", level="ERROR"),
            patch.object(conditions_api, "parse_today", side_effect=RuntimeError(secret)),
        ):
            status, body = self.request({"text": secret})
        self.assert_error(status, body, 500, "PARSER_FAILED")
        self.assertNotIn(secret, json.dumps(body, ensure_ascii=False))

    def test_parse_requests_are_independent_and_do_not_call_route_service(self):
        with patch.object(main, "recommend_routes") as route_service:
            self.assert_result("유모차를 끌고 있어요", {"stroller": True})
            self.assert_result("오늘은 날씨가 좋아요", {})
            route_service.assert_not_called()

    def test_parse_result_never_relaxes_blocked_stairs_profile(self):
        parsed = self.assert_result("계단 피할 필요 없어요", {"avoidStairs": False})
        route_request = {
            "start": {"lat": 37.6616768, "lng": 127.0379543},
            "end": {"lat": 37.6528758, "lng": 127.0245012},
            "profile": {"stairs": "blocked"},
            "today": parsed["today"],
        }
        self.assert_error(
            *self.request(route_request, path="/api/routes"), 404, "NO_ROUTE"
        )

    def test_openapi_describes_parser_and_existing_route_errors_stay_unchanged(self):
        status, document = self.request(path="/openapi.json", method="GET")
        self.assertEqual(status, 200)
        self.assertEqual(set(document["paths"]), {
            "/health", "/api/routes", "/api/conditions/parse"
        })
        operation = document["paths"]["/api/conditions/parse"]["post"]
        components = document["components"]["schemas"]
        self.assertEqual(components["ParseRequest"]["properties"]["text"]["type"], "string")
        self.assertIs(components["ParseRequest"]["additionalProperties"], False)
        self.assertNotIn("umbrella", components["ParsedToday"]["properties"])
        self.assertTrue({"422", "500"}.issubset(operation["responses"]))
        self.assert_error(
            *self.request({}, path="/api/routes"), 422, "VALIDATION_ERROR"
        )


if __name__ == "__main__":
    unittest.main()

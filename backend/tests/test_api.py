"""Real HTTP checks: python -B -m unittest discover -s backend/tests -v."""

from __future__ import annotations

import copy
import json
import logging
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
import route_service_v02 as route_service  # noqa: E402
import uvicorn  # noqa: E402


class RouteApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.example_request = json.loads(
            (REPO_DIR / "docs" / "example_input.json").read_text(encoding="utf-8")
        )
        cls.example_response = json.loads(
            (REPO_DIR / "docs" / "example_output.json").read_text(encoding="utf-8")
        )
        cls.nodes = {
            str(node["nodeId"]): {"lat": node["lat"], "lng": node["lng"]}
            for node in json.loads(
                (BACKEND_DIR / "nodes.json").read_text(encoding="utf-8")
            )
        }
        cls._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        cls._socket.bind(("127.0.0.1", 0))
        cls._socket.listen(128)
        cls.base_url = f"http://127.0.0.1:{cls._socket.getsockname()[1]}"
        cls._server = uvicorn.Server(
            uvicorn.Config(
                main.app,
                host="127.0.0.1",
                port=0,
                log_level="critical",
                access_log=False,
                lifespan="off",
                proxy_headers=False,
            )
        )
        cls._server_errors = []

        def run_server():
            try:
                cls._server.run(sockets=[cls._socket])
            except BaseException as exc:
                cls._server_errors.append(exc)

        cls._thread = threading.Thread(target=run_server, daemon=True)
        cls.addClassCleanup(cls._stop_server)
        cls._thread.start()
        deadline = time.monotonic() + 10
        while not cls._server.started:
            if not cls._thread.is_alive() or time.monotonic() >= deadline:
                raise RuntimeError(f"Temporary HTTP server failed: {cls._server_errors}")
            time.sleep(0.01)
        cls._opener = build_opener(ProxyHandler({}))

    @classmethod
    def _stop_server(cls):
        cls._server.should_exit = True
        cls._thread.join(timeout=10)
        cls._socket.close()
        if cls._thread.is_alive():
            raise RuntimeError("Temporary HTTP server did not stop")
        if cls._server_errors:
            raise RuntimeError(f"Temporary HTTP server failed: {cls._server_errors}")

    def _http(self, path, method="GET", payload=None, raw=None):
        headers = {}
        if payload is not None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if raw is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.base_url + path, data=raw, headers=headers, method=method)
        try:
            response = self._opener.open(request, timeout=10)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, response.headers, response.read()

    def _json(self, path, method="GET", payload=None, raw=None):
        status, headers, body = self._http(path, method, payload, raw)
        self.assertEqual(headers.get_content_type(), "application/json")
        return status, json.loads(body.decode("utf-8"))

    def _assert_error(self, status, body, expected_status, code=None):
        self.assertEqual(status, expected_status)
        self.assertEqual(set(body), {"error"})
        self.assertEqual(set(body["error"]), {"code", "message"})
        self.assertIsInstance(body["error"]["code"], str)
        self.assertTrue(body["error"]["code"])
        self.assertIsInstance(body["error"]["message"], str)
        self.assertTrue(body["error"]["message"])
        if code is not None:
            self.assertEqual(body["error"]["code"], code)
        encoded = json.dumps(body, ensure_ascii=False)
        for internal_text in ("Traceback", "route_service_v02.py", "PRIVATE_INTERNAL_DETAIL"):
            self.assertNotIn(internal_text, encoded)

    @staticmethod
    def _without_request_id(response):
        return {key: value for key, value in response.items() if key != "requestId"}

    def _assert_matches_real_service(self, payload):
        expected = route_service.recommend_routes(payload)
        status, actual = self._json("/api/routes", "POST", payload)
        self.assertEqual(status, 200)
        self.assertIsInstance(actual["requestId"], str)
        self.assertTrue(actual["requestId"].startswith("req_"))
        self.assertEqual(
            self._without_request_id(actual), self._without_request_id(expected)
        )
        self.assertGreaterEqual(len(actual["routes"]), 1)
        self.assertLessEqual(len(actual["routes"]), 3)
        return actual

    def test_health_and_swagger_ui(self):
        status, body = self._json("/health")
        self.assertEqual((status, body), (200, {"status": "ok"}))
        status, headers, body = self._http("/docs")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "text/html")
        self.assertIn(b"SwaggerUIBundle", body)

    def test_openapi_documents_strict_inputs_and_required_nullable_outputs(self):
        status, document = self._json("/openapi.json")
        self.assertEqual(status, 200)
        self.assertEqual(
            set(document["paths"]),
            {"/health", "/api/routes", "/api/conditions/parse"},
        )

        def resolve(schema):
            while "$ref" in schema:
                value = document
                for part in schema["$ref"].removeprefix("#/").split("/"):
                    value = value[part]
                schema = value
            if "anyOf" in schema:
                schema = next(item for item in schema["anyOf"] if item.get("type") != "null")
                return resolve(schema)
            return schema

        operation = document["paths"]["/api/routes"]["post"]
        request_schema = resolve(
            operation["requestBody"]["content"]["application/json"]["schema"]
        )
        self.assertTrue({"start", "end", "profile"}.issubset(request_schema["required"]))
        self.assertIs(request_schema["additionalProperties"], False)
        for name in ("start", "end", "profile", "today"):
            nested = resolve(request_schema["properties"][name])
            self.assertIs(nested["additionalProperties"], False)
        today = resolve(request_schema["properties"]["today"])
        self.assertNotIn("umbrella", today["properties"])

        response_schema = resolve(
            operation["responses"]["200"]["content"]["application/json"]["schema"]
        )
        self.assertIn("sameRoute", response_schema["required"])
        self.assertEqual(response_schema["properties"]["sameRoute"]["type"], "boolean")
        routes_schema = response_schema["properties"]["routes"]
        self.assertEqual(routes_schema["minItems"], 1)
        self.assertEqual(routes_schema["maxItems"], 3)
        route_schema = resolve(routes_schema["items"])
        for name in ("ascentM", "maxSlopePercent", "crosswalkCount"):
            self.assertIn(name, route_schema["required"])
            self.assertIn({"type": "null"}, route_schema["properties"][name]["anyOf"])
        self.assertIn("gradeCoveragePercent", route_schema["required"])
        coverage = route_schema["properties"]["gradeCoveragePercent"]
        self.assertEqual((coverage["minimum"], coverage["maximum"]), (0, 100))

    def test_documented_example_matches_real_service_and_stored_response(self):
        actual = self._assert_matches_real_service(self.example_request)
        self.assertEqual(
            self._without_request_id(actual), self._without_request_id(self.example_response)
        )
        self.assertIs(actual["sameRoute"], True)
        self.assertEqual(len(actual["routes"]), 3)
        for route in actual["routes"]:
            self.assertEqual(route["gradeCoveragePercent"], 0.0)
            for name in ("ascentM", "maxSlopePercent", "crosswalkCount"):
                self.assertIn(name, route)
                self.assertIsNone(route[name])
            self.assertEqual(route["stairsCount"], 0)
            self.assertTrue(any("무장애" in warning for warning in route["warnings"]))

    def test_real_duksung_gate_coordinates(self):
        self._assert_matches_real_service(
            {
                "start": {"lat": 37.6517, "lng": 127.0149},
                "end": {"lat": 37.6526, "lng": 127.0174},
                "profile": {"stairs": "allowed"},
            }
        )

    def test_optional_today_and_client_id_preserve_a_defaults(self):
        for today_mode in ("omitted", "null", "empty"):
            with self.subTest(today=today_mode):
                payload = copy.deepcopy(self.example_request)
                payload.pop("today")
                if today_mode != "omitted":
                    payload["today"] = None if today_mode == "null" else {}
                payload["clientId"] = None if today_mode == "null" else "demo-client"
                self._assert_matches_real_service(payload)

    def test_unknown_fields_are_rejected_at_every_request_level(self):
        for level in (None, "start", "end", "profile", "today"):
            with self.subTest(level=level):
                payload = copy.deepcopy(self.example_request)
                target = payload if level is None else payload[level]
                target["unexpected"] = True
                self._assert_error(
                    *self._json("/api/routes", "POST", payload), 422, "VALIDATION_ERROR"
                )
        payload = copy.deepcopy(self.example_request)
        payload["today"]["umbrella"] = True
        self._assert_error(*self._json("/api/routes", "POST", payload), 422, "VALIDATION_ERROR")

    def test_invalid_enums_and_client_id_types_are_rejected(self):
        for field, value in (("stairs", "never"), ("stairs", True), ("crosswalks", "blocked")):
            with self.subTest(field=field, value=value):
                payload = copy.deepcopy(self.example_request)
                payload["profile"][field] = value
                self._assert_error(
                    *self._json("/api/routes", "POST", payload), 422, "VALIDATION_ERROR"
                )
        for value in (123, False, {}, []):
            with self.subTest(clientId=value):
                payload = copy.deepcopy(self.example_request)
                payload["clientId"] = value
                self._assert_error(
                    *self._json("/api/routes", "POST", payload), 422, "VALIDATION_ERROR"
                )

    def test_boolean_fields_do_not_coerce_numbers_strings_or_null(self):
        fields = {
            "profile": ("detourAllowed", "gentleSlope", "comfortFirst"),
            "today": ("suitcase", "tired", "stroller", "injuredLeg", "avoidStairs", "allowDetour"),
        }
        for section, names in fields.items():
            for name in names:
                for value in (0, 1, "true", None):
                    with self.subTest(section=section, name=name, value=value):
                        payload = copy.deepcopy(self.example_request)
                        payload[section][name] = value
                        self._assert_error(
                            *self._json("/api/routes", "POST", payload), 422, "VALIDATION_ERROR"
                        )

    def test_coordinates_require_finite_in_range_numbers(self):
        cases = (
            ("start", "lat", True), ("start", "lng", False),
            ("start", "lat", "37.6529198"), ("end", "lng", "127.0217959"),
            ("end", "lat", None), ("start", "lat", 90.1),
            ("end", "lat", -90.1), ("start", "lng", 180.1),
            ("end", "lng", -180.1), ("start", "lat", float("nan")),
            ("start", "lng", float("inf")), ("end", "lat", float("-inf")),
        )
        for section, name, value in cases:
            with self.subTest(section=section, name=name, value=value):
                payload = copy.deepcopy(self.example_request)
                payload[section][name] = value
                self._assert_error(
                    *self._json("/api/routes", "POST", payload), 422, "VALIDATION_ERROR"
                )

    def test_missing_fields_and_wrong_object_types_are_rejected(self):
        payloads = [[], "not an object", {"start": None}, copy.deepcopy(self.example_request)]
        payloads[-1]["profile"].pop("stairs")
        for field in ("start", "end", "profile"):
            payload = copy.deepcopy(self.example_request)
            payload.pop(field)
            payloads.append(payload)
        for field in ("start", "end", "profile", "today"):
            payload = copy.deepcopy(self.example_request)
            payload[field] = []
            payloads.append(payload)
        for index, payload in enumerate(payloads):
            with self.subTest(case=index):
                self._assert_error(
                    *self._json("/api/routes", "POST", payload), 422, "VALIDATION_ERROR"
                )

    def test_malformed_json_and_null_body_use_the_error_contract(self):
        for raw in (b"{", b'{"start":', b"null", b""):
            with self.subTest(raw=raw):
                self._assert_error(
                    *self._json("/api/routes", "POST", raw=raw), 422, "VALIDATION_ERROR"
                )

    def test_same_node_returns_validation_error(self):
        payload = copy.deepcopy(self.example_request)
        payload["end"] = copy.deepcopy(payload["start"])
        self._assert_error(*self._json("/api/routes", "POST", payload), 422, "VALIDATION_ERROR")

    def test_real_stairs_blocked_nodes_return_no_route(self):
        payload = {
            "start": self.nodes["11077238940"],
            "end": self.nodes["3844064764"],
            "profile": {"stairs": "blocked"},
        }
        with self.assertRaises(route_service.RouteServiceError) as caught:
            route_service.recommend_routes(payload)
        self.assertEqual((caught.exception.http_status, caught.exception.code), (404, "NO_ROUTE"))
        self._assert_error(*self._json("/api/routes", "POST", payload), 404, "NO_ROUTE")

    def test_real_outside_coverage_returns_data_unavailable(self):
        payload = copy.deepcopy(self.example_request)
        payload["start"] = {"lat": 0, "lng": 0}
        self._assert_error(*self._json("/api/routes", "POST", payload), 503, "DATA_UNAVAILABLE")

    def test_route_service_error_adapter_preserves_public_status_code_and_message(self):
        error = route_service.RouteServiceError(503, "DATA_UNAVAILABLE", "경로 데이터를 사용할 수 없습니다.")
        with patch.object(main, "recommend_routes", side_effect=error):
            status, body = self._json("/api/routes", "POST", self.example_request)
        self._assert_error(status, body, 503, "DATA_UNAVAILABLE")
        self.assertEqual(body["error"]["message"], error.message)

    def test_unexpected_exception_is_a_generic_500_without_internal_details(self):
        previous_logging_level = logging.root.manager.disable
        try:
            logging.disable(logging.CRITICAL)
            with patch.object(
                main, "recommend_routes", side_effect=RuntimeError("PRIVATE_INTERNAL_DETAIL")
            ):
                status, body = self._json("/api/routes", "POST", self.example_request)
        finally:
            logging.disable(previous_logging_level)
        self._assert_error(status, body, 500, "INTERNAL_ERROR")

    def test_unapproved_endpoints_and_wrong_methods_use_the_error_contract(self):
        for path in ("/api/route-selections",):
            with self.subTest(path=path):
                self._assert_error(*self._json(path, "POST"), 404)
        self._assert_error(*self._json("/api/routes"), 405)


if __name__ == "__main__":
    unittest.main()

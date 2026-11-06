"""쉼터 API의 원본 데이터 보존과 실패 계약을 실제 로컬 HTTP로 검증합니다."""

from __future__ import annotations

from contextlib import contextmanager
import copy
import hashlib
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


BACKEND_DIR = Path(__file__).resolve().parents[1]
DATA_PATH = BACKEND_DIR / "data" / "manual_rest_spots.json"
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402
import rest_spots_api  # noqa: E402
import uvicorn  # noqa: E402


class RestSpotsApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source_bytes = DATA_PATH.read_bytes()
        cls.source_rows = json.loads(cls.source_bytes.decode("utf-8"))
        cls.source_digest = hashlib.sha256(cls.source_bytes).hexdigest()
        cls.unavailable_message = None
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
        cls.server_errors = []

        def run_server():
            try:
                cls.server.run(sockets=[cls.sock])
            except BaseException as exc:
                cls.server_errors.append(exc)

        cls.thread = threading.Thread(target=run_server, daemon=True)
        cls.addClassCleanup(cls.stop_server)
        cls.thread.start()
        deadline = time.monotonic() + 10
        while not cls.server.started:
            if not cls.thread.is_alive() or time.monotonic() >= deadline:
                raise RuntimeError("쉼터 테스트 HTTP 서버를 시작하지 못했습니다.")
            time.sleep(0.01)
        cls.opener = build_opener(ProxyHandler({}))

    @classmethod
    def stop_server(cls):
        cls.server.should_exit = True
        cls.thread.join(timeout=10)
        cls.sock.close()
        if cls.thread.is_alive():
            raise RuntimeError("쉼터 테스트 HTTP 서버가 종료되지 않았습니다.")
        if cls.server_errors:
            raise RuntimeError("쉼터 테스트 HTTP 서버에서 예외가 발생했습니다.")
        if hashlib.sha256(DATA_PATH.read_bytes()).hexdigest() != cls.source_digest:
            raise AssertionError("쉼터 API 테스트가 저장소의 원본 데이터를 변경했습니다.")

    def request(self, path="/api/rest-spots", method="GET"):
        request = Request(
            self.base_url + path, method=method,
            headers={"Connection": "close"},
        )
        try:
            response = self.opener.open(request, timeout=10)
        except HTTPError as exc:
            response = exc
        with response:
            self.assertEqual(response.headers.get_content_type(), "application/json")
            return response.status, json.loads(response.read().decode("utf-8"))

    @contextmanager
    def raw_data(self, content):
        with tempfile.TemporaryDirectory(prefix="naranhi-rest-spots-") as directory:
            temporary_path = Path(directory) / "PRIVATE_REST_FILE.json"
            temporary_path.write_bytes(content)
            with patch.object(rest_spots_api, "DATA_PATH", temporary_path):
                yield temporary_path

    @contextmanager
    def json_data(self, rows):
        content = json.dumps(rows, ensure_ascii=False, allow_nan=True).encode("utf-8")
        with self.raw_data(content) as temporary_path:
            yield temporary_path

    def assert_unavailable(self, status, body):
        self.assertEqual(status, 503)
        self.assertEqual(set(body), {"error"})
        self.assertEqual(set(body["error"]), {"code", "message"})
        self.assertEqual(body["error"]["code"], "DATA_UNAVAILABLE")
        message = body["error"]["message"]
        self.assertIsInstance(message, str)
        self.assertRegex(message, "[가-힣]")
        if self.__class__.unavailable_message is None:
            self.__class__.unavailable_message = message
        self.assertEqual(message, self.__class__.unavailable_message)
        encoded = json.dumps(body, ensure_ascii=False)
        for private_text in (
            "Traceback", "ValidationError", "UnicodeDecodeError", "AppData",
            "rest_spots_api.py", "PRIVATE_REST_FILE", "PRIVATE_REST_INTERNAL_DETAIL",
        ):
            self.assertNotIn(private_text, encoded)

    def test_success_preserves_all_four_manual_records_and_original_values(self):
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"restSpots", "dataSource", "warnings"})
        self.assertEqual(len(body["restSpots"]), 4)
        self.assertEqual(
            [item["name"] for item in body["restSpots"]],
            [item["name"] for item in self.source_rows],
        )
        field_mapping = {
            "name": "name", "lat": "lat", "lng": "lng", "type": "type",
            "verification": "verificationMethod",
            "accessibility_verified": "accessibilityVerified",
            "bench_count": "benchCount", "note": "note",
            "rest_features": "restFeatures", "address": "address",
            "osm_name": "osmName", "streetview_lat": "streetviewLat",
            "streetview_lng": "streetviewLng",
        }
        ids = []
        for source, item in zip(self.source_rows, body["restSpots"]):
            with self.subTest(name=source["name"]):
                self.assertEqual(set(item), {"id", *field_mapping.values()})
                self.assertEqual(set(source) - set(field_mapping), set())
                for original, public in field_mapping.items():
                    self.assertEqual(item[public], source.get(original))
                self.assertIs(item["accessibilityVerified"], False)
                if source["bench_count"] is None:
                    self.assertIsNone(item["benchCount"])
                else:
                    self.assertIs(type(item["benchCount"]), int)
                self.assertIsInstance(item["id"], str)
                self.assertTrue(item["id"].strip())
                ids.append(item["id"])
        self.assertEqual(len(set(ids)), 4)

    def test_manual_source_and_accessibility_uncertainty_are_explicit(self):
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(body["dataSource"], "manual_rest_spots.json")
        self.assertEqual(len(body["warnings"]), 4)
        for warning in body["warnings"]:
            self.assertIsInstance(warning, str)
            self.assertRegex(warning, "[가-힣]")
        warnings = " ".join(body["warnings"])
        self.assertIn("접근성", warnings)
        self.assertRegex(warnings, "미확인|확인되지|검증되지|미검증")
        for distance_term in ("직선거리", "보행", "우회거리"):
            self.assertIn(distance_term, warnings)
        self.assertIn("벤치 개수 미확인은 벤치가 없다는 뜻이 아닙니다.", warnings)

    def test_loader_returns_response_model_and_does_not_modify_source(self):
        result = rest_spots_api.load_rest_spots()
        self.assertIsInstance(result, rest_spots_api.RestSpotsResponse)
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(result.model_dump(), body)
        self.assertEqual(hashlib.sha256(DATA_PATH.read_bytes()).hexdigest(), self.source_digest)

    def test_ids_are_stable_when_manual_records_are_reordered(self):
        status, original = self.request()
        self.assertEqual(status, 200)
        original_ids = {item["name"]: item["id"] for item in original["restSpots"]}
        reordered = list(reversed(copy.deepcopy(self.source_rows)))
        with self.json_data(reordered):
            status, actual = self.request()
        self.assertEqual(status, 200)
        self.assertEqual([item["name"] for item in actual["restSpots"]], [row["name"] for row in reordered])
        self.assertEqual({item["name"]: item["id"] for item in actual["restSpots"]}, original_ids)

    def test_missing_unreadable_and_invalid_unicode_files_return_503(self):
        with tempfile.TemporaryDirectory(prefix="naranhi-rest-errors-") as directory:
            for label, temporary_path in (
                ("missing", Path(directory) / "PRIVATE_REST_FILE_missing.json"),
                ("directory", Path(directory)),
            ):
                with self.subTest(case=label), patch.object(rest_spots_api, "DATA_PATH", temporary_path):
                    self.assert_unavailable(*self.request())
        with self.raw_data(b"\xff\xfePRIVATE_REST_INTERNAL_DETAIL"):
            self.assert_unavailable(*self.request())
        with patch.object(Path, "open", side_effect=OSError("PRIVATE_REST_INTERNAL_DETAIL")):
            self.assert_unavailable(*self.request())

    def test_malformed_json_returns_503_without_parser_details(self):
        for raw in (b"", b"[", b'{"PRIVATE_REST_INTERNAL_DETAIL":', b"[{},]"):
            with self.subTest(raw=raw), self.raw_data(raw):
                self.assert_unavailable(*self.request())

    def test_invalid_root_record_shape_and_record_count_return_503(self):
        cases = (
            None, {}, "PRIVATE_REST_INTERNAL_DETAIL", [],
            self.source_rows[:3], self.source_rows + [self.source_rows[0]],
            [None, *self.source_rows[1:]],
            [[], *self.source_rows[1:]],
        )
        for index, rows in enumerate(cases):
            with self.subTest(case=index), self.json_data(rows):
                self.assert_unavailable(*self.request())

    def test_duplicate_names_are_rejected_instead_of_producing_duplicate_ids(self):
        rows = copy.deepcopy(self.source_rows)
        rows[1]["name"] = rows[0]["name"]
        with self.json_data(rows):
            self.assert_unavailable(*self.request())

    def test_missing_required_fields_and_unknown_fields_return_503(self):
        required = (
            "name", "lat", "lng", "type", "rest_features", "bench_count",
            "verification", "accessibility_verified", "note",
        )
        for key in required:
            rows = copy.deepcopy(self.source_rows)
            del rows[0][key]
            with self.subTest(missing=key), self.json_data(rows):
                self.assert_unavailable(*self.request())
        rows = copy.deepcopy(self.source_rows)
        rows[0]["PRIVATE_REST_INTERNAL_DETAIL"] = "unsupported"
        with self.json_data(rows):
            self.assert_unavailable(*self.request())

    def test_empty_text_invalid_verification_and_rest_features_return_503(self):
        cases = (
            ("name", ""), ("name", "  \t"), ("name", 123),
            ("type", "  "), ("note", ""),
            ("verification", "automatically_verified"),
            ("rest_features", []), ("rest_features", "bench"),
            ("rest_features", [""]), ("rest_features", [False]),
            ("address", " "), ("osm_name", ""),
        )
        for field, value in cases:
            rows = copy.deepcopy(self.source_rows)
            rows[0][field] = value
            with self.subTest(field=field, value=value), self.json_data(rows):
                self.assert_unavailable(*self.request())

    def test_coordinates_are_finite_numbers_in_bounds_and_streetview_is_a_pair(self):
        cases = (
            ("lat", -90.1), ("lat", 90.1), ("lng", -180.1), ("lng", 180.1),
            ("lat", float("nan")), ("lng", float("inf")),
            ("lat", "37.65"), ("lng", False), ("lat", None),
            ("streetview_lat", 91), ("streetview_lng", -181),
            ("streetview_lat", float("inf")), ("streetview_lng", "127.02"),
        )
        for field, value in cases:
            rows = copy.deepcopy(self.source_rows)
            rows[0][field] = value
            with self.subTest(field=field, value=value), self.json_data(rows):
                self.assert_unavailable(*self.request())
        for missing in ("streetview_lat", "streetview_lng"):
            rows = copy.deepcopy(self.source_rows)
            del rows[0][missing]
            with self.subTest(missing=missing), self.json_data(rows):
                self.assert_unavailable(*self.request())

    def test_bench_counts_and_accessibility_flags_are_strict_without_coercion(self):
        cases = (
            ("bench_count", -1), ("bench_count", 1.5), ("bench_count", "2"),
            ("bench_count", False), ("accessibility_verified", "false"),
            ("accessibility_verified", 0), ("accessibility_verified", None),
        )
        for field, value in cases:
            rows = copy.deepcopy(self.source_rows)
            rows[0][field] = value
            with self.subTest(field=field, value=value), self.json_data(rows):
                self.assert_unavailable(*self.request())

    def test_data_failure_keeps_health_available_and_recovers_without_restart(self):
        with self.raw_data(b"[") as temporary_path:
            self.assert_unavailable(*self.request())
            self.assertEqual(self.request("/health"), (200, {"status": "ok"}))
            temporary_path.write_bytes(self.source_bytes)
            status, body = self.request()
            self.assertEqual(status, 200)
            self.assertEqual(len(body["restSpots"]), 4)
        self.assertEqual(self.request("/health"), (200, {"status": "ok"}))

    def test_only_get_is_supported_and_other_methods_use_common_error_json(self):
        for method in ("POST", "PUT", "DELETE"):
            with self.subTest(method=method):
                status, body = self.request(method=method)
                self.assertEqual(status, 405)
                self.assertEqual(set(body), {"error"})
                self.assertEqual(set(body["error"]), {"code", "message"})
                self.assertEqual(body["error"]["code"], "METHOD_NOT_ALLOWED")
                self.assertTrue(body["error"]["message"])

    def test_openapi_documents_exact_output_fields_nullable_counts_and_503(self):
        status, document = self.request("/openapi.json")
        self.assertEqual(status, 200)
        self.assertEqual(set(document["paths"]), {
            "/health", "/api/routes", "/api/conditions/parse", "/api/rest-spots",
        })
        self.assertEqual(set(document["paths"]["/api/rest-spots"]), {"get"})
        operation = document["paths"]["/api/rest-spots"]["get"]
        self.assertTrue({"200", "503"}.issubset(operation["responses"]))

        def resolve(schema):
            while "$ref" in schema:
                value = document
                for part in schema["$ref"].removeprefix("#/").split("/"):
                    value = value[part]
                schema = value
            return schema

        schema = resolve(operation["responses"]["200"]["content"]["application/json"]["schema"])
        self.assertEqual(set(schema["properties"]), {"restSpots", "dataSource", "warnings"})
        spot = resolve(schema["properties"]["restSpots"]["items"])
        self.assertEqual(set(spot["properties"]), {
            "id", "name", "lat", "lng", "type", "verificationMethod",
            "accessibilityVerified", "benchCount", "note", "restFeatures",
            "address", "osmName", "streetviewLat", "streetviewLng",
        })
        self.assertEqual(spot["properties"]["accessibilityVerified"]["type"], "boolean")
        bench = spot["properties"]["benchCount"]
        self.assertIn({"type": "null"}, bench["anyOf"])
        self.assertTrue(any(item.get("type") == "integer" and item.get("minimum") == 0 for item in bench["anyOf"]))
        self.assertEqual(spot["properties"]["lat"]["minimum"], -90)
        self.assertEqual(spot["properties"]["lat"]["maximum"], 90)
        self.assertEqual(spot["properties"]["lng"]["minimum"], -180)
        self.assertEqual(spot["properties"]["lng"]["maximum"], 180)
        error = resolve(operation["responses"]["503"]["content"]["application/json"]["schema"])
        self.assertEqual(set(error["properties"]), {"error"})
        error_detail = resolve(error["properties"]["error"])
        self.assertEqual(set(error_detail["properties"]), {"code", "message"})


if __name__ == "__main__":
    unittest.main()
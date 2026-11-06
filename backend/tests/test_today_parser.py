"""Rule parser checks without writing input text or changing route fixtures."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import sys
import unittest


BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from today_parser import InvalidTextError, parse_today, validate_text  # noqa: E402


class TodayParserTests(unittest.TestCase):
    allowed_conditions = {
        "suitcase", "stroller", "injuredLeg", "tired", "avoidStairs", "allowDetour"
    }

    def assert_contract(self, result):
        self.assertEqual(
            set(result),
            {"today", "recognizedTerms", "warnings", "requiresConfirmation", "parserMethod"},
        )
        self.assertIsInstance(result["today"], dict)
        self.assertLessEqual(set(result["today"]), self.allowed_conditions)
        self.assertTrue(all(type(value) is bool for value in result["today"].values()))
        for field in ("recognizedTerms", "warnings"):
            self.assertIsInstance(result[field], list)
            self.assertTrue(all(isinstance(value, str) for value in result[field]))
        self.assertIs(result["requiresConfirmation"], True)
        self.assertEqual(result["parserMethod"], "rules")

    def test_affirmative_expressions_return_only_recognized_condition(self):
        cases = (
            ("캐리어가 있어요", "suitcase"),
            ("여행가방", "suitcase"),
            ("유모차를 끌고 있어요", "stroller"),
            ("다리를 다쳤어요", "injuredLeg"),
            ("다리가 아파요", "injuredLeg"),
            ("목발", "injuredLeg"),
            ("계단은 피하고 싶어요", "avoidStairs"),
            ("조금 돌아가도 괜찮아요", "allowDetour"),
            ("피곤해요", "tired"),
        )
        for text, field in cases:
            with self.subTest(text=text):
                result = parse_today(text)
                self.assert_contract(result)
                self.assertEqual(result["today"], {field: True})
                self.assertTrue(result["recognizedTerms"])

    def test_explicit_negatives_are_false_without_inferred_conditions(self):
        cases = (
            ("캐리어 없어요", "suitcase"),
            ("유모차를 안 끌어요", "stroller"),
            ("다리 안 다쳤어요", "injuredLeg"),
            ("계단 피할 필요 없어요", "avoidStairs"),
            ("안 피곤해요", "tired"),
            ("피곤하지 않아요", "tired"),
            ("캐리어가 있지 않아요", "suitcase"),
            ("유모차를 끌지 않아요", "stroller"),
            ("다리가 안 아파요", "injuredLeg"),
            ("다리 통증이 없어요", "injuredLeg"),
            ("돌아가고 싶지 않아요", "allowDetour"),
            ("돌아가도 괜찮지 않아요", "allowDetour"),
        )
        for text, field in cases:
            with self.subTest(text=text):
                result = parse_today(text)
                self.assert_contract(result)
                self.assertEqual(result["today"], {field: False})
                self.assertTrue(result["recognizedTerms"])

    def test_not_using_crutches_does_not_confirm_an_injury(self):
        for text in ("목발 없어요", "목발을 안 써요", "목발을 쓰지 않아요"):
            with self.subTest(text=text):
                result = parse_today(text)
                self.assert_contract(result)
                self.assertIsNot(result["today"].get("injuredLeg"), True)
                if "injuredLeg" not in result["today"]:
                    self.assertTrue(result["warnings"])

    def test_inability_to_avoid_stairs_is_not_an_avoidance_preference(self):
        result = parse_today("계단을 못 피해요")
        self.assert_contract(result)
        self.assertNotIn("avoidStairs", result["today"])
        self.assertTrue(result["warnings"])

    def test_one_request_can_recognize_all_six_conditions(self):
        result = parse_today(
            "캐리어가 있어요. 유모차를 끌고 있어요. 다리를 다쳤어요. "
            "피곤해요. 계단은 피하고 싶어요. 조금 돌아가도 괜찮아요."
        )
        self.assert_contract(result)
        self.assertEqual(result["today"], dict.fromkeys(self.allowed_conditions, True))

    def test_negative_scope_does_not_reverse_another_condition(self):
        cases = (
            (
                "캐리어는 없어요. 유모차를 끌고 있어요.",
                {"suitcase": False, "stroller": True},
            ),
            (
                "캐리어가 있어요. 유모차는 없어요.",
                {"suitcase": True, "stroller": False},
            ),
            (
                "다리 안 다쳤어요. 피곤해요.",
                {"injuredLeg": False, "tired": True},
            ),
            (
                "캐리어는 없고 유모차는 있어요",
                {"suitcase": False, "stroller": True},
            ),
            (
                "캐리어는 없어요 유모차는 있어요",
                {"suitcase": False, "stroller": True},
            ),
            (
                "피곤하지만 캐리어는 없어요",
                {"tired": True, "suitcase": False},
            ),
        )
        for text, expected in cases:
            with self.subTest(text=text):
                result = parse_today(text)
                self.assert_contract(result)
                self.assertEqual(result["today"], expected)

    def test_shared_negative_applies_to_both_named_conditions(self):
        result = parse_today("캐리어와 유모차 둘 다 없어요")
        self.assert_contract(result)
        self.assertEqual(result["today"], {"suitcase": False, "stroller": False})

    def test_uncertain_condition_is_omitted_and_warned(self):
        result = parse_today("캐리어 있을 수도 있어요")
        self.assert_contract(result)
        self.assertNotIn("suitcase", result["today"])
        self.assertTrue(result["warnings"])

    def test_question_and_conditional_contexts_are_not_confirmed_states(self):
        cases = (
            ("캐리어가 있나요?", {"suitcase"}),
            ("캐리어가 있으면 계단을 피할게요", {"suitcase", "avoidStairs"}),
        )
        for text, unresolved in cases:
            with self.subTest(text=text):
                result = parse_today(text)
                self.assert_contract(result)
                self.assertTrue(unresolved.isdisjoint(result["today"]))
                self.assertTrue(result["warnings"])

    def test_past_positive_does_not_override_a_current_negative(self):
        result = parse_today("어제는 피곤했지만 지금은 피곤하지 않아요")
        self.assert_contract(result)
        self.assertIsNot(result["today"].get("tired"), True)
        if "tired" not in result["today"]:
            self.assertTrue(result["warnings"])

    def test_conflicting_mentions_are_omitted_and_warned(self):
        cases = (
            ("캐리어가 있어요. 캐리어는 없어요.", "suitcase"),
            ("피곤해요. 안 피곤해요.", "tired"),
        )
        for text, field in cases:
            with self.subTest(text=text):
                result = parse_today(text)
                self.assert_contract(result)
                self.assertNotIn(field, result["today"])
                self.assertTrue(result["warnings"])

    def test_unrecognized_text_is_success_with_empty_today_and_warning(self):
        result = parse_today("오늘 날씨가 좋아요")
        self.assert_contract(result)
        self.assertEqual(result["today"], {})
        self.assertEqual(result["recognizedTerms"], [])
        self.assertTrue(result["warnings"])

    def test_umbrella_never_becomes_a_supported_condition(self):
        result = parse_today("우산을 쓰고 있어요")
        self.assert_contract(result)
        self.assertEqual(result["today"], {})
        self.assertNotIn("umbrella", result["today"])
        self.assertTrue(result["warnings"])

    def test_empty_whitespace_and_non_string_inputs_are_invalid(self):
        for text in ("", " \t\n\u3000", None, 123, [], {}):
            with self.subTest(text=text):
                with self.assertRaises(InvalidTextError):
                    validate_text(text)
                with self.assertRaises(InvalidTextError):
                    parse_today(text)

    def test_text_length_boundary_excludes_all_whitespace(self):
        for text in ("가", "가" * 500, "  " + "가" * 500 + " \n", "가 \t" * 500):
            with self.subTest(length=len(text)):
                validate_text(text)
                self.assert_contract(parse_today(text))
        for text in ("가" * 501, " \t" + "가" * 501 + " \n"):
            with self.subTest(length=len(text)):
                with self.assertRaises(InvalidTextError):
                    validate_text(text)
                with self.assertRaises(InvalidTextError):
                    parse_today(text)

    def test_raw_sentence_is_not_returned_in_terms_or_warnings(self):
        text = "개인 메모 ABC-987: 캐리어가 있어요."
        result = parse_today(text)
        self.assert_contract(result)
        self.assertEqual(result["today"], {"suitcase": True})
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn(text, serialized)
        self.assertNotIn("ABC-987", serialized)
        self.assertNotIn("개인 메모", serialized)

    def test_calls_do_not_share_mutable_results_or_previous_state(self):
        first = parse_today("캐리어가 있어요")
        original = copy.deepcopy(first)
        negative = parse_today("캐리어 없어요")
        self.assertEqual(negative["today"], {"suitcase": False})
        self.assertEqual(first, original)

        first["today"]["suitcase"] = False
        first["recognizedTerms"].append("private marker")
        first["warnings"].append("private marker")
        self.assertEqual(parse_today("캐리어가 있어요"), original)
        unknown = parse_today("오늘 날씨가 좋아요")
        self.assertEqual(unknown["today"], {})
        self.assertNotIn("private marker", json.dumps(unknown))


if __name__ == "__main__":
    unittest.main()

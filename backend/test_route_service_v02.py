
"""API v0.2 경로 추천 함수 테스트"""

import json
from pathlib import Path

from route_service_v02 import (
    recommend_routes,
    RouteServiceError
)

BASE = Path(__file__).resolve().parent


# 경로 추천 함수 시험
def test_case(
    label,
    start,
    end,
    profile,
    today=None
):

    print(f"\n===== {label} =====")

    request = {
        "start": start,
        "end": end,
        "profile": profile,
        "today": today or {}
    }

    try:
        result = recommend_routes(request)

        
        # 추가된 반환 필드 확인
        assert isinstance(result.get("sameRoute"), bool), \
            "sameRoute 필드가 없습니다."

        assert all(
            isinstance(route.get("gradeCoveragePercent"), (int, float))
            and 0 <= route["gradeCoveragePercent"] <= 100
            for route in result["routes"]
        ), "gradeCoveragePercent 필드를 확인해 주세요."

        print("동일 경로 여부:", result["sameRoute"])

        for route in result["routes"]:
            print(
                route["id"],
                "경사 데이터 확인 비율:",
                route["gradeCoveragePercent"],
                "%"
            )


        print(
            "requestId:",
            result["requestId"]
        )

        print(
            "추천 경로 수:",
            len(result["routes"])
        )

        for item in result["routes"]:

            print(
                item["id"],
                item["label"],
                "거리:",
                item["distanceM"],
                "m",
                "확인된 계단:",
                item["stairsCount"],
                "상승고도:",
                item["ascentM"],
                "횡단 횟수:",
                item["crosswalkCount"],
                "좌표:",
                len(item["coordinates"]),
                "개"
            )

        print(
            "전체 경고:",
            result["warnings"]
        )

        return result

    except RouteServiceError as exc:

        print(
            "HTTP:",
            exc.http_status,
            exc.to_response()
        )

        return None


# 기존 노드 좌표 불러오기
def lookup_nodes():

    with (
        BASE / "nodes.json"
    ).open(encoding="utf-8") as f:

        nodes = {
            str(n["nodeId"]): {
                "lat": n["lat"],
                "lng": n["lng"]
            }
            for n in json.load(f)
        }

    return nodes


# 실제 테스트
if __name__ == "__main__":

    # 1. 덕성여대 인근 일반 경로
    test_case(
        "덕성여대 인근 - 일반",
        {
            "lat": 37.6517,
            "lng": 127.0149
        },
        {
            "lat": 37.6526,
            "lng": 127.0174
        },
        {
            "stairs": "allowed"
        }
    )

    # 2. 기존에 확인한 계단 테스트 구간
    nodes = lookup_nodes()

    start = nodes["3848336080"]
    end = nodes["4950129794"]

    # 계단 허용
    basic = test_case(
        "계단 구간 - 계단 허용",
        start,
        end,
        {"stairs": "allowed"}
    )

    # 계단 차단
    blocked = test_case(
        "계단 구간 - 계단 차단",
        start,
        end,
        {"stairs": "blocked"}
    )

    # 유모차 이용
    stroller = test_case(
        "계단 구간 - 오늘 유모차",
        start,
        end,
        {"stairs": "avoid"},
        {"stroller": True}
    )

    # 유모차 이용 시 확인된 계단 제외 검증
    assert stroller is not None, "유모차 경로를 찾지 못했습니다."

    assert stroller["routes"], "유모차 추천 경로가 없습니다."

    assert all(
        route["stairsCount"] == 0
        for route in stroller["routes"]
    ), "유모차 경로에 확인된 계단이 포함되었습니다."

    print("검증 완료: 유모차 추천 경로에 확인된 계단 없음")

    # 함수 입력 예시와 실제 반환 JSON 저장
    example_request = {
        "start": start,
        "end": end,
        "profile": {"stairs": "avoid"},
        "today": {"stroller": True}
    }

    (BASE / "example_input.json").write_text(
        json.dumps(example_request, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    (BASE / "example_output.json").write_text(
        json.dumps(stroller, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    print("입력 및 반환 JSON 파일 저장 완료!")

    # 3. 계단 차단 결과 검증
    if blocked is not None:

        assert all(
            route["stairsCount"] == 0
            for route in blocked["routes"]
        )

        print(
            "\n검증 완료: 계단 차단 결과에 "
            "확인된 계단 구간 없음"
        )

    # 4. 계단 허용/차단 비교
    if basic and blocked:

        print(
            "계단 허용/차단 대표 거리:",
            basic["routes"][0]["distanceM"],
            "→",
            blocked["routes"][0]["distanceM"]
        )

    print(
        "\nAPI v0.2 경로 서비스 테스트 완료!"
    )

    # 5. 최대 경사도 반영 테스트
    from route_service_v02 import _edge_cost

    slope_profile = {
        "stairs": "allowed",
        "detourAllowed": False,
        "gentleSlope": True,
        "crosswalks": "allowed",
        "comfortFirst": False
    }

    slope_today = {
        "suitcase": False,
        "tired": False,
        "stroller": False,
        "injuredLeg": False,
        "avoidStairs": False,
        "allowDetour": False
    }

    edge = {
        "lengthM": 100,
        "stairs": "no",
        "gradeStatus": "coarse_estimate",
        "gradePctForward": 3.0,
        "maxAbsGradePct": 9.0
    }

    steep_cost = _edge_cost(edge, slope_profile, slope_today)

    edge["maxAbsGradePct"] = 3.0
    normal_cost = _edge_cost(edge, slope_profile, slope_today)

    assert steep_cost > normal_cost, "최대 경사도 가중치 적용 실패"

    print("검증 완료: 최대 경사도 회피 가중치 적용")

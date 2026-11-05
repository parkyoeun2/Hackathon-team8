
"""맞춤형 보행 경로 추천 계산 서비스 (API 명세 v0.2 대응).

실행 환경: Python 3.10+, networkx
같은 폴더에 nodes.json, edges.json이 있어야 합니다.

FastAPI 사용 예:
    from route_service_v02 import recommend_routes, RouteServiceError
    response = recommend_routes(request_body)

주의:
- ROUTE-01의 계산 서비스이며 FastAPI 엔드포인트 자체는 아닙니다.
- OSM 태그가 없는 구간을 안전하다고 단정하지 않습니다.
- DEM 기반 경사는 참고용 추정치입니다.
- 미확인 값은 None으로 반환합니다.
  (API 명세의 nullable 여부는 백엔드 B와 합의 필요)
"""

from __future__ import annotations

import json
import math
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any

import networkx as nx


DATA_DIR = Path(__file__).resolve().parent

# 가장 가까운 도로 노드에 연결할 최대 거리
# MVP 시험용 설정
MAX_SNAP_M = 250.0


# 1. 오류 처리
class RouteServiceError(Exception):

    def __init__(
        self,
        http_status: int,
        code: str,
        message: str
    ):
        super().__init__(message)
        self.http_status = http_status
        self.code = code
        self.message = message

    def to_response(self):
        return {
            "error": {
                "code": self.code,
                "message": self.message
            }
        }


def _invalid(message):
    raise RouteServiceError(
        422,
        "VALIDATION_ERROR",
        message
    )


# 2. 요청 데이터 검증
def _object(value, name, required=True):

    if value is None and not required:
        return {}

    if not isinstance(value, dict):
        _invalid(f"{name} 항목은 객체여야 합니다.")

    return value


def _boolean(obj, key, default=False):

    value = obj.get(key, default)

    if type(value) is not bool:
        _invalid(
            f"{key} 항목은 true 또는 false여야 합니다."
        )

    return value


def _choice(obj, key, allowed, default=None):

    value = obj.get(key, default)

    if not isinstance(value, str) or value not in allowed:
        _invalid(
            f"{key} 항목은 "
            f"{', '.join(allowed)} 중 하나여야 합니다."
        )

    return value


def _location(body, key):

    obj = _object(body.get(key), key)
    result = {}

    for field, low, high in (
        ("lat", -90.0, 90.0),
        ("lng", -180.0, 180.0)
    ):

        value = obj.get(field)

        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
        ):
            _invalid(
                f"{key}.{field} 항목은 숫자여야 합니다."
            )

        number = float(value)

        if (
            not math.isfinite(number)
            or not low <= number <= high
        ):
            _invalid(
                f"{key}.{field} 좌표 범위를 확인해 주세요."
            )

        result[field] = number

    return result


def _validate_request(body):

    body = _object(body, "요청 본문")

    start = _location(body, "start")
    end = _location(body, "end")

    profile = _object(
        body.get("profile"),
        "profile"
    )

    today = _object(
        body.get("today"),
        "today",
        required=False
    )

    # API v0.2의 profile 필드
    normalized_profile = {
        "stairs": _choice(
            profile,
            "stairs",
            ("allowed", "avoid", "blocked")
        ),
        "detourAllowed": _boolean(
            profile, "detourAllowed"
        ),
        "gentleSlope": _boolean(
            profile, "gentleSlope"
        ),
        "crosswalks": _choice(
            profile,
            "crosswalks",
            ("allowed", "avoid"),
            "allowed"
        ),
        "comfortFirst": _boolean(
            profile, "comfortFirst"
        )
    }

    # API v0.2의 today 필드
    today_keys = (
        "suitcase",
        "tired",
        "stroller",
        "injuredLeg",
        "avoidStairs",
        "allowDetour"
    )

    normalized_today = {
        key: _boolean(today, key)
        for key in today_keys
    }

    client_id = body.get("clientId")

    if (
        client_id is not None
        and not isinstance(client_id, str)
    ):
        _invalid(
            "clientId 항목은 문자열이어야 합니다."
        )

    return {
        "start": start,
        "end": end,
        "profile": normalized_profile,
        "today": normalized_today,
        "clientId": client_id
    }


# 3. 위도/경도 사이 거리 계산
def _haversine(lat1, lng1, lat2, lng2):

    radius = 6371000.0

    a1 = math.radians(lat1)
    a2 = math.radians(lat2)

    dlat = a2 - a1
    dlng = math.radians(lng2 - lng1)

    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(a1) * math.cos(a2)
        * math.sin(dlng / 2) ** 2
    )

    return 2 * radius * math.asin(
        min(1.0, math.sqrt(h))
    )


# 4. 기존 JSON 데이터 읽기
@lru_cache(maxsize=1)
def _load_data():

    try:
        with (
            DATA_DIR / "nodes.json"
        ).open(encoding="utf-8") as f:
            nodes = json.load(f)

        with (
            DATA_DIR / "edges.json"
        ).open(encoding="utf-8") as f:
            edges = json.load(f)

        graph = nx.MultiDiGraph()

        for node in nodes:
            graph.add_node(
                str(node["nodeId"]),
                lat=float(node["lat"]),
                lng=float(node["lng"])
            )

        info = {}

        for edge in edges:

            u = str(edge["fromNode"])
            v = str(edge["toNode"])

            if (
                not graph.has_node(u)
                or not graph.has_node(v)
            ):
                raise ValueError(
                    "간선의 노드 ID가 nodes.json에 없습니다."
                )

            if not float(edge["lengthM"]) > 0:
                raise ValueError(
                    "길이가 0 이하인 간선이 있습니다."
                )

            edge_id = str(edge["edgeId"])

            info[edge_id] = edge

            graph.add_edge(
                u,
                v,
                edgeId=edge_id
            )

        if (
            not graph.number_of_nodes()
            or not graph.number_of_edges()
        ):
            raise ValueError(
                "빈 보행 네트워크입니다."
            )

        return graph, info

    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        json.JSONDecodeError
    ) as exc:

        raise RouteServiceError(
            503,
            "DATA_UNAVAILABLE",
            "이 지역의 경로 데이터를 "
            "일시적으로 이용할 수 없습니다."
        ) from exc


# 5. 가장 가까운 노드 찾기
def _nearest_node(graph, loc):

    node_id, distance = min(
        (
            (
                node_id,
                _haversine(
                    loc["lat"],
                    loc["lng"],
                    attrs["lat"],
                    attrs["lng"]
                )
            )
            for node_id, attrs in graph.nodes(data=True)
        ),
        key=lambda item: item[1]
    )

    if distance > MAX_SNAP_M:
        raise RouteServiceError(
            503,
            "DATA_UNAVAILABLE",
            "입력한 위치는 현재 지원하는 "
            "보행 데이터 범위 밖입니다."
        )

    return node_id


# 6. 이동 상태별 구간 비용 계산

def _edge_cost(edge, profile, today):

    length = float(edge["lengthM"])
    stairs = edge.get("stairs", "unknown")

    policy = profile["stairs"]

    # 계단 차단 설정 또는 오늘 유모차 이용 시
    # 확인된 계단 구간은 탐색에서 제외
    if stairs == "yes" and (
        policy == "blocked"
        or today["stroller"]
    ):
        return None

    # 우회 허용 및 편안함 우선 설정
    distance_factor = 1.0

    if (
        profile["detourAllowed"]
        or today["allowDetour"]
    ):
        distance_factor *= 0.90

    if profile["comfortFirst"]:
        distance_factor *= 0.85

    cost = length * distance_factor

    # 확인된 계단
    if stairs == "yes":

        penalty = {
            "allowed": 0.0,
            "avoid": 700.0,
            "blocked": 0.0
        }[policy]

        if today["suitcase"]:
            penalty += 800.0

        if today["stroller"]:
            penalty += 1300.0

        if today["injuredLeg"]:
            penalty += 1200.0

        if today["avoidStairs"]:
            penalty += 900.0

        cost += penalty

    # 계단 여부 미확인
    elif stairs != "no":

        unknown_stairs_factor = 0.02

        if (
            today["stroller"]
            or today["injuredLeg"]
        ):
            unknown_stairs_factor += 0.04

        cost += length * unknown_stairs_factor

    
    # 경사도 정보 확인
    grade = edge.get("gradePctForward")
    max_grade = edge.get("maxAbsGradePct")
    status = edge.get("gradeStatus")

    if (
        status == "coarse_estimate"
        and grade is not None
    ):

        grade = float(grade)

        # 90m DEM 기반 추정 경사값
        steepness = max(
            abs(grade),
            abs(float(max_grade)) if max_grade is not None else 0.0
        )

        # 급경사 판단 기준은 임시 테스트 값
        if steepness >= 6.0:

            slope_factor = 0.0

            if profile["gentleSlope"]:
                slope_factor += 2.5

            if profile["comfortFirst"]:
                slope_factor += 0.8

            if today["suitcase"]:
                slope_factor += (
                    1.8 if grade > 0 else 1.0
                )

            if today["stroller"]:
                slope_factor += (
                    3.0 if grade > 0 else 2.0
                )

            if today["injuredLeg"]:
                slope_factor += (
                    3.0 if grade > 0 else 2.5
                )

            if today["tired"]:
                slope_factor += (
                    2.0 if grade > 0 else 0.8
                )

            cost += length * slope_factor

    else:
        # 경사 미확인 구간을 평지로 간주하지 않음
        uncertainty = 0.05

        if profile["gentleSlope"]:
            uncertainty += 0.05

        if (
            today["stroller"]
            or today["injuredLeg"]
        ):
            uncertainty += 0.10

        if (
            today["tired"]
            or today["suitcase"]
        ):
            uncertainty += 0.05

        cost += length * uncertainty

    # OSM에 확인된 횡단 구간 회피
    if (
        profile["crosswalks"] == "avoid"
        and edge.get("crossingTagged") is True
    ):
        cost += 90.0

    return cost


# 7. 최단거리 및 맞춤형 그래프 생성
def _make_graphs(graph, edges, profile, today):

    weighted = nx.DiGraph()
    shortest = nx.DiGraph()

    weighted.add_nodes_from(graph.nodes)
    shortest.add_nodes_from(graph.nodes)

    for u, v, data in graph.edges(data=True):

        edge = edges[data["edgeId"]]

        cost = _edge_cost(
            edge,
            profile,
            today
        )

        if cost is None:
            continue

        length = float(edge["lengthM"])

        # 맞춤형 가중치 그래프
        if (
            not weighted.has_edge(u, v)
            or cost < weighted[u][v]["weight"]
        ):
            weighted.add_edge(
                u,
                v,
                weight=cost,
                lengthM=length,
                edge=edge
            )

        # 거리 기반 그래프
        if (
            not shortest.has_edge(u, v)
            or length < shortest[u][v]["lengthM"]
        ):
            shortest.add_edge(
                u,
                v,
                lengthM=length,
                edge=edge
            )

    return weighted, shortest


# 8. 경로 구간 목록
def _route_edges(graph, path):

    return [
        graph[u][v]["edge"]
        for u, v in zip(
            path[:-1],
            path[1:]
        )
    ]


def _route_distance(edges):

    return sum(
        float(edge["lengthM"])
        for edge in edges
    )


# 9. 지도 표시용 경로 좌표
def _coordinates(path, edges, graph):

    coordinates = []

    for index, edge in enumerate(edges):

        u = path[index]
        v = path[index + 1]

        raw = edge.get("geometry") or [
            [
                graph.nodes[u]["lng"],
                graph.nodes[u]["lat"]
            ],
            [
                graph.nodes[v]["lng"],
                graph.nodes[v]["lat"]
            ]
        ]

        segment = [
            [float(p[0]), float(p[1])]
            for p in raw
        ]

        if len(segment) < 2:
            segment = [
                [
                    graph.nodes[u]["lng"],
                    graph.nodes[u]["lat"]
                ],
                [
                    graph.nodes[v]["lng"],
                    graph.nodes[v]["lat"]
                ]
            ]

        lat = graph.nodes[u]["lat"]
        lng = graph.nodes[u]["lng"]

        dist_first = _haversine(
            lat,
            lng,
            segment[0][1],
            segment[0][0]
        )

        dist_last = _haversine(
            lat,
            lng,
            segment[-1][1],
            segment[-1][0]
        )

        if dist_last < dist_first:
            segment.reverse()

        if coordinates:

            gap = _haversine(
                coordinates[-1][1],
                coordinates[-1][0],
                segment[0][1],
                segment[0][0]
            )

            if gap < 0.2:
                coordinates.extend(segment[1:])
            else:
                coordinates.extend(segment)

        else:
            coordinates.extend(segment)

    return coordinates


# 10. 경로 응답 데이터 생성
def _format_route(
    path,
    edge_list,
    graph,
    route_num,
    kind,
    profile,
    today
):

    distance = _route_distance(edge_list)

    stairs_count = sum(
        e.get("stairs") == "yes"
        for e in edge_list
    )

    unknown_stairs = sum(
        e.get("stairs", "unknown")
        not in ("yes", "no")
        for e in edge_list
    )

    unknown_kerbs = sum(
        e.get("kerbStatus", "unknown") == "unknown"
        for e in edge_list
    )

    unknown_grade = sum(
        e.get("gradeStatus") != "coarse_estimate"
        or e.get("gradePctForward") is None
        for e in edge_list
    )

    # 경사 정보가 확인된 거리의 비율
    known_grade_distance = sum(
        float(e["lengthM"])
        for e in edge_list
        if e.get("gradeStatus") == "coarse_estimate"
        and e.get("gradePctForward") is not None
    )

    grade_coverage = round(
        known_grade_distance / distance * 100, 1
    ) if distance > 0 else 0.0


    # 일부 구간이 미확인이면 전체 경사 정보도 null
    ascent_known = all(
        e.get("gradeStatus") == "coarse_estimate"
        and e.get("ascentForwardM") is not None
        for e in edge_list
    )

    slope_known = all(
        e.get("gradeStatus") == "coarse_estimate"
        and e.get("maxAbsGradePct") is not None
        for e in edge_list
    )

    crosswalk_known = all(
        e.get("crosswalkCount") is not None
        for e in edge_list
    )

    if ascent_known:
        ascent_m = round(
            sum(
                float(e["ascentForwardM"])
                for e in edge_list
            ),
            1
        )
    else:
        ascent_m = None

    if slope_known and edge_list:
        max_slope = round(
            max(
                abs(float(e["maxAbsGradePct"]))
                for e in edge_list
            ),
            2
        )
    else:
        max_slope = None

    if crosswalk_known:
        crosswalk_count = sum(
            int(e["crosswalkCount"])
            for e in edge_list
        )
    else:
        crosswalk_count = None

    # 11. 경고 메시지
    warnings = []

    if unknown_grade:
        warnings.append(
            f"경사도가 미확인된 구간 "
            f"{unknown_grade}개가 있습니다."
        )

    if unknown_stairs:
        warnings.append(
            f"계단 여부가 미확인된 구간 "
            f"{unknown_stairs}개가 있습니다."
        )

    if unknown_kerbs:
        warnings.append(
            "일부 구간의 보도 턱·단차 정보가 "
            "확인되지 않았습니다."
        )

    if not crosswalk_known:
        warnings.append(
            "실제 횡단보도 횟수를 확인할 수 없습니다."
        )

    if len(edge_list) > unknown_grade:
        warnings.append(
            "경사도는 90m DEM 기반 참고용 "
            "추정값이며 보행로 실측값이 아닙니다."
        )

    if profile["crosswalks"] == "avoid":
        warnings.append(
            "횡단 회피는 OSM에 표시된 "
            "횡단 구간만 참고합니다."
        )


    if (
        profile["stairs"] == "blocked"
        or today["stroller"]
    ):
        warnings.append(
            "계단 미표시 구간에도 장애물이 있을 수 있어 "
            "무장애 경로를 보장하지 않습니다."
        )

    # 12. 경로 종류별 설명
    if kind == "preferred":
        label = "맞춤 추천"
        reason = (
            "입력한 계단·경사 선호와 오늘의 이동 상태를 "
            "반영해 계산한 경로입니다."
        )

    elif kind == "shortest":
        label = "최단 거리"
        reason = (
            "적용된 계단 차단 조건 안에서 "
            "이동 거리가 가장 짧은 경로입니다."
        )

    else:
        label = "대안 경로"
        reason = (
            "동일한 출발지와 목적지 사이에서 "
            "찾은 다른 보행 경로입니다."
        )

    # API v0.2 경로 응답
    return {
        "id": f"route_{route_num}",
        "label": label,
        "distanceM": round(distance, 1),
        "ascentM": ascent_m,
        "maxSlopePercent": max_slope,
        "gradeCoveragePercent": grade_coverage,
        "crosswalkCount": crosswalk_count,
        "stairsCount": stairs_count,
        "coordinates": _coordinates(
            path, edge_list, graph
        ),
        "reason": reason,
        "warnings": warnings
    }


# 13. FastAPI에서 호출할 메인 함수
def recommend_routes(request_body):

    request = _validate_request(
        request_body
    )

    graph, edge_info = _load_data()

    start = _nearest_node(
        graph,
        request["start"]
    )

    end = _nearest_node(
        graph,
        request["end"]
    )

    if start == end:
        _invalid(
            "출발지와 도착지가 같은 보행 노드로 "
            "연결되었습니다. 위치를 다시 선택해 주세요."
        )

    profile = request["profile"]
    today = request["today"]

    weighted, shortest = _make_graphs(
        graph,
        edge_info,
        profile,
        today
    )

    # 최단거리 및 맞춤 추천 경로
    try:
        shortest_path = nx.shortest_path(
            shortest,
            start,
            end,
            weight="lengthM"
        )

        preferred_path = nx.shortest_path(
            weighted,
            start,
            end,
            weight="weight"
        )

    except (
        nx.NetworkXNoPath,
        nx.NodeNotFound
    ) as exc:

        raise RouteServiceError(
            404,
            "NO_ROUTE",
            "현재 설정에 맞는 경로를 찾지 못했습니다."
        ) from exc

    min_length = _route_distance(
        _route_edges(
            shortest,
            shortest_path
        )
    )

    detour_allowed = (
        profile["detourAllowed"]
        or today["allowDetour"]
    )

    # MVP 시험용 최대 우회 비율
    max_ratio = (
        3.0 if detour_allowed else 2.5
    )

    candidates = []
    seen = set()

    # 중복되거나 과도하게 먼 경로 제외
    def offer(kind, use_graph, path):

        chosen = _route_edges(
            use_graph,
            path
        )

        identifier = tuple(
            str(e["edgeId"])
            for e in chosen
        )

        if not identifier or identifier in seen:
            return

        if (
            _route_distance(chosen)
            > min_length * max_ratio
        ):
            return

        seen.add(identifier)

        candidates.append(
            (kind, use_graph, path)
        )

    # 맞춤 추천 경로
    offer(
        "preferred",
        weighted,
        preferred_path
    )

    # 최단거리 경로
    offer(
        "shortest",
        shortest,
        shortest_path
    )

    # 추가 대안 경로 탐색
    if len(candidates) < 3:

        try:
            for index, path in enumerate(
                nx.shortest_simple_paths(
                    weighted,
                    start,
                    end,
                    weight="weight"
                )
            ):

                if (
                    index >= 20
                    or len(candidates) >= 3
                ):
                    break

                offer(
                    "alternative",
                    weighted,
                    path
                )

        except (
            nx.NetworkXNoPath,
            nx.NodeNotFound
        ):
            pass

    if not candidates:
        raise RouteServiceError(
            404,
            "NO_ROUTE",
            "현재 설정에 맞는 경로를 찾지 못했습니다."
        )
 # 맞춤 추천과 최단 거리 경로가 동일한지 확인
    preferred_edges = tuple(
        str(e["edgeId"])
        for e in _route_edges(weighted, preferred_path)
    )

    shortest_edges = tuple(
        str(e["edgeId"])
        for e in _route_edges(shortest, shortest_path)
    )

    same_route = preferred_edges == shortest_edges
    # 경로 최대 3개
    routes = [
        _format_route(
            path,
            _route_edges(use_graph, path),
            graph,
            i,
            kind,
            profile,
            today
        )
        for i, (
            kind,
            use_graph,
            path
        ) in enumerate(
            candidates[:3],
            start=1
        )
    ]

    global_warnings = [
        "보행로 정보가 미확인된 구간은 "
        "장애물이 없는 길로 간주하지 않습니다."
    ]

    if any(
        r["ascentM"] is None
        or r["maxSlopePercent"] is None
        or r["crosswalkCount"] is None
        for r in routes
    ):
        global_warnings.append(
            "일부 고도·경사·횡단 횟수는 "
            "확인되지 않아 null로 제공됩니다."
        )

    if len(routes) == 1:
        global_warnings.append(
            "현재 조건에서 서로 다른 대체 경로를 "
            "추가로 찾지 못했습니다."
        )

    # API v0.2 최종 응답
 
    return {
        "requestId": (
            "req_" + uuid.uuid4().hex[:12]
        ),
        "routes": routes,
        "sameRoute": same_route,
        "warnings": global_warnings
    }

"""정적 시연 데이터로 휴식 공간 후보를 제공하는 읽기 전용 API."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Literal
from uuid import NAMESPACE_URL, uuid5

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import Field, TypeAdapter, model_validator

from schemas import ContractModel, ErrorResponse


DATA_PATH = Path(__file__).resolve().parent / "data" / "manual_rest_spots.json"
DEMO_SPOT_COUNT = 4
DATA_UNAVAILABLE_MESSAGE = (
    "휴식 공간 후보 정보를 불러올 수 없습니다. 잠시 후 다시 확인해 주세요."
)
DATA_WARNINGS = (
    "휴식 공간 후보이며 이용 가능 여부나 무장애를 보장하지 않습니다. "
    "접근성 미검증은 접근 불가를 뜻하지 않습니다.",
    "현재 시설 상태, 외부인 이용 가능 여부와 실제 보행 접근성은 별도 확인이 필요합니다.",
    "벤치 개수 미확인은 벤치가 없다는 뜻이 아닙니다. "
    "모든 공원·놀이터에 벤치가 있다고 가정하지 않습니다.",
    "설명 속 거리값은 특정 시연 경로와 시설 경계 또는 대표 지점 사이의 직선거리입니다. "
    "현재 선택 경로의 보행 접근거리나 우회거리로 사용할 수 없습니다.",
)

Text = Annotated[str, Field(min_length=1, pattern=r"\S")]
Latitude = Annotated[float, Field(ge=-90, le=90)]
Longitude = Annotated[float, Field(ge=-180, le=180)]
VerificationMethod = Literal["map_visual", "field_observation"]


class ManualRestSpot(ContractModel):
    """A의 원본 필드 이름과 값을 그대로 검증합니다."""

    name: Text
    lat: Latitude
    lng: Longitude
    type: Text
    rest_features: list[Text] = Field(min_length=1)
    bench_count: int | None = Field(ge=0)
    verification: VerificationMethod
    accessibility_verified: bool
    note: Text
    osm_name: Text | None = None
    address: Text | None = None
    streetview_lat: Latitude | None = None
    streetview_lng: Longitude | None = None

    @model_validator(mode="after")
    def check_streetview_pair(self) -> ManualRestSpot:
        if (self.streetview_lat is None) != (self.streetview_lng is None):
            raise ValueError("거리뷰 위도와 경도는 함께 있어야 합니다.")
        return self


MANUAL_SPOTS = TypeAdapter(
    Annotated[
        list[ManualRestSpot],
        Field(min_length=DEMO_SPOT_COUNT, max_length=DEMO_SPOT_COUNT),
    ]
)


class RestSpot(ContractModel):
    id: str = Field(description="후보 이름에서 생성한 안정적인 고유 식별자")
    name: str
    lat: Latitude
    lng: Longitude
    type: str
    verificationMethod: VerificationMethod
    accessibilityVerified: bool = Field(
        description="false는 접근 가능 여부가 검증되지 않았다는 뜻이며 접근 불가를 뜻하지 않음"
    )
    benchCount: int | None = Field(
        ge=0, description="확인한 벤치 개수. null은 개수 미확인이며 벤치 부재를 뜻하지 않음"
    )
    note: str = Field(description="원본 설명. 거리값이 있으면 특정 시연 경로 기준의 직선거리")
    restFeatures: list[str]
    address: str | None
    osmName: str | None
    streetviewLat: Latitude | None
    streetviewLng: Longitude | None


class RestSpotsResponse(ContractModel):
    restSpots: list[RestSpot] = Field(
        min_length=DEMO_SPOT_COUNT,
        max_length=DEMO_SPOT_COUNT,
        description="정적 시연 데이터의 휴식 공간 후보 4곳",
    )
    dataSource: Literal["manual_rest_spots.json"]
    warnings: list[str]


def load_rest_spots() -> RestSpotsResponse:
    # 요청할 때 읽어 누락·손상 시 성공한 빈 목록이나 오래된 값으로 대체하지 않습니다.
    # __file__ 기준 경로이므로 실행 터미널의 현재 폴더와 무관합니다.
    with DATA_PATH.open(encoding="utf-8-sig") as stream:
        raw = json.load(stream)
    spots = MANUAL_SPOTS.validate_python(raw, strict=True)
    result = [
        RestSpot(
            id="rest_" + uuid5(NAMESPACE_URL, "naranhi:rest-spot:" + spot.name).hex,
            name=spot.name,
            lat=spot.lat,
            lng=spot.lng,
            type=spot.type,
            verificationMethod=spot.verification,
            accessibilityVerified=spot.accessibility_verified,
            benchCount=spot.bench_count,
            note=spot.note,
            restFeatures=spot.rest_features,
            address=spot.address,
            osmName=spot.osm_name,
            streetviewLat=spot.streetview_lat,
            streetviewLng=spot.streetview_lng,
        )
        for spot in spots
    ]
    if len({spot.id for spot in result}) != len(result):
        raise ValueError("중복된 휴식 공간 후보가 있습니다.")
    return RestSpotsResponse(
        restSpots=result,
        dataSource="manual_rest_spots.json",
        warnings=list(DATA_WARNINGS),
    )


router = APIRouter()


@router.get(
    "/api/rest-spots",
    response_model=RestSpotsResponse,
    response_model_exclude_none=False,
    responses={
        503: {"model": ErrorResponse, "description": "후보 데이터 누락·읽기 실패·형식 오류"},
    },
)
def rest_spots() -> RestSpotsResponse | JSONResponse:
    try:
        return load_rest_spots()
    except (OSError, ValueError):
        # 파일 경로·원문·검증 오류 상세는 외부 응답에 포함하지 않습니다.
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "code": "DATA_UNAVAILABLE",
                    "message": DATA_UNAVAILABLE_MESSAGE,
                }
            },
        )
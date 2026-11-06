"""A 경로 서비스와 연결하는 요청·응답 계약."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Location(ContractModel):
    lat: float = Field(ge=-90, le=90, description="WGS84 위도")
    lng: float = Field(ge=-180, le=180, description="WGS84 경도")


class Profile(ContractModel):
    stairs: Literal["allowed", "avoid", "blocked"]
    detourAllowed: bool = False
    gentleSlope: bool = False
    crosswalks: Literal["allowed", "avoid"] = "allowed"
    comfortFirst: bool = False


class TodayCondition(ContractModel):
    suitcase: bool = False
    tired: bool = False
    stroller: bool = False
    injuredLeg: bool = False
    avoidStairs: bool = False
    allowDetour: bool = False


class RouteRequest(ContractModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "start": {"lat": 37.6517, "lng": 127.0149},
                "end": {"lat": 37.6526, "lng": 127.0174},
                "profile": {"stairs": "avoid"},
            }
        }
    )

    start: Location
    end: Location
    profile: Profile
    today: TodayCondition | None = None
    clientId: str | None = None


Coordinate = Annotated[list[float], Field(min_length=2, max_length=2)]


class Route(ContractModel):
    id: str
    label: str
    distanceM: float = Field(ge=0)
    ascentM: float | None = Field(ge=0)
    maxSlopePercent: float | None = Field(ge=0)
    gradeCoveragePercent: float = Field(
        ge=0,
        le=100,
        description="확인 가능한 경사 데이터 구간의 거리 비율(0~100%)",
    )
    stairsCount: int = Field(ge=0)
    crosswalkCount: int | None = Field(ge=0)
    coordinates: list[Coordinate] = Field(description="[경도, 위도] 순서의 좌표 목록")
    reason: str
    warnings: list[str]


class RouteResponse(ContractModel):
    requestId: str
    routes: list[Route] = Field(min_length=1, max_length=3)
    sameRoute: bool = Field(description="계산한 맞춤 경로와 최단 경로의 간선 목록이 같은지 여부")
    warnings: list[str]


class ErrorDetail(ContractModel):
    code: str
    message: str


class ErrorResponse(ContractModel):
    error: ErrorDetail

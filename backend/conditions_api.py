"""규칙 기반 오늘 상태 분석 API. 원문을 저장하거나 로그에 기록하지 않습니다."""

from typing import Any, Callable, Coroutine, Literal

from fastapi import APIRouter, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from pydantic import Field, field_validator
from starlette.exceptions import HTTPException

from schemas import ContractModel, ErrorResponse
from today_parser import InvalidTextError, parse_today, validate_text


INVALID_TEXT_MESSAGE = "오늘의 이동 상황을 공백 제외 1~500자로 입력해 주세요."
PARSER_FAILED_MESSAGE = "문장 분석에 실패했습니다. 항목을 직접 선택해 주세요."


class ParseRequest(ContractModel):
    text: str = Field(
        description="공백 문자를 제외한 길이 1~500자. 원문은 저장하지 않습니다.",
        examples=["캐리어가 있고 다리가 아파요. 조금 돌아가도 괜찮아요."],
    )

    @field_validator("text")
    @classmethod
    def check_text(cls, value: str) -> str:
        return validate_text(value)


class ParsedToday(ContractModel):
    suitcase: bool | None = None
    stroller: bool | None = None
    injuredLeg: bool | None = None
    tired: bool | None = None
    avoidStairs: bool | None = None
    allowDetour: bool | None = None


class ParseResponse(ContractModel):
    today: ParsedToday
    recognizedTerms: list[str]
    warnings: list[str]
    requiresConfirmation: Literal[True]
    parserMethod: Literal["rules"]


def parse_error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}},
    )


class ConditionsRoute(APIRoute):
    """분석 API의 오류만 변환하여 기존 경로 API 처리를 유지합니다."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original_handler = super().get_route_handler()

        async def handle(request: Request) -> Response:
            try:
                return await original_handler(request)
            except (RequestValidationError, InvalidTextError):
                return parse_error(422, "INVALID_TEXT", INVALID_TEXT_MESSAGE)
            except HTTPException as exc:
                if exc.status_code < 500:
                    return parse_error(422, "INVALID_TEXT", INVALID_TEXT_MESSAGE)
                return parse_error(500, "PARSER_FAILED", PARSER_FAILED_MESSAGE)
            except Exception:
                # 원문이나 예외 상세를 응답·로그에 싣지 않습니다.
                return parse_error(500, "PARSER_FAILED", PARSER_FAILED_MESSAGE)

        return handle


router = APIRouter(route_class=ConditionsRoute)


@router.post(
    "/api/conditions/parse",
    response_model=ParseResponse,
    response_model_exclude_none=True,
    responses={
        422: {"model": ErrorResponse, "description": "텍스트·요청 형식 검증 실패"},
        500: {"model": ErrorResponse, "description": "상태 분석 중 내부 오류"},
    },
)
def parse_conditions(request: ParseRequest):
    return parse_today(request.text)

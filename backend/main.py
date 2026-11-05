"""나란히 FastAPI 앱: A의 경로 계산 함수를 HTTP API로 연결합니다."""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from conditions_api import router as conditions_router
from route_service_v02 import RouteServiceError, recommend_routes
from schemas import ErrorResponse, RouteRequest, RouteResponse


app = FastAPI()
app.include_router(conditions_router)


def error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    return error_response(
        422, "VALIDATION_ERROR", "출발지·도착지와 이동 조건을 확인해 주세요."
    )


@app.exception_handler(RouteServiceError)
async def route_service_error_handler(
    request: Request, exc: RouteServiceError
) -> JSONResponse:
    return JSONResponse(status_code=exc.http_status, content=exc.to_response())


@app.exception_handler(HTTPException)
async def http_error_handler(request: Request, exc: HTTPException) -> JSONResponse:
    code, message = {
        404: ("NOT_FOUND", "요청한 API를 찾을 수 없습니다."),
        405: ("METHOD_NOT_ALLOWED", "지원하지 않는 요청 방식입니다."),
    }.get(exc.status_code, ("HTTP_ERROR", "요청을 처리할 수 없습니다."))
    response = error_response(exc.status_code, code, message)
    if exc.headers:
        response.headers.update(exc.headers)
    return response


@app.exception_handler(Exception)
async def internal_error_handler(request: Request, exc: Exception) -> JSONResponse:
    return error_response(
        500, "INTERNAL_ERROR", "경로를 계산하는 중 문제가 발생했습니다."
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post(
    "/api/routes",
    response_model=RouteResponse,
    response_model_exclude_none=False,
    responses={
        422: {"model": ErrorResponse, "description": "요청 검증 실패"},
        404: {"model": ErrorResponse, "description": "조건에 맞는 경로 없음"},
        503: {"model": ErrorResponse, "description": "보행 데이터 사용 불가"},
        500: {"model": ErrorResponse, "description": "예상하지 못한 서버 오류"},
    },
)
def routes(request: RouteRequest):
    return recommend_routes(request.model_dump())

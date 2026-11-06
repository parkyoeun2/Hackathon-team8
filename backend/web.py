"""기존 프론트 화면과 정적 파일을 동일한 FastAPI 출처에서 제공합니다."""

from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


APP_DIR = Path(__file__).resolve().parents[1] / "app"
TEMPLATE_DIR = APP_DIR / "templates"
PAGES = frozenset({"profile", "home", "result", "route", "check"})
router = APIRouter(include_in_schema=False)


@router.get("/")
def home_redirect() -> RedirectResponse:
    return RedirectResponse("/home.html", status_code=307)


@router.get("/{page_name}.html", response_class=FileResponse)
def page(page_name: str) -> FileResponse:
    if page_name not in PAGES:
        raise HTTPException(status_code=404)
    return FileResponse(
        TEMPLATE_DIR / f"{page_name}.html",
        media_type="text/html",
        headers={"Cache-Control": "no-store"},
    )


def install_frontend(app: FastAPI) -> None:
    app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
    app.include_router(router)

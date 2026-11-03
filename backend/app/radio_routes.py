import mimetypes

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/radio", tags=["radio"])


@router.get("")
def index(request: Request) -> dict:
    return request.app.state.radio.snapshot()


@router.get("/state")
def state(request: Request) -> dict:
    """只报「现在放哪首、第几秒」。客户端定期校准用，不重复发整张曲库。"""
    return request.app.state.radio.state()


@router.get("/{track_id}")
def track(track_id: str, request: Request) -> FileResponse:
    path = request.app.state.radio.path_for(track_id)
    if path is None:
        raise HTTPException(404, "曲目不存在")
    return FileResponse(
        path,
        media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        # 音频文件不会原地改动；一天的本地缓存足够，拖动进度也不必回源。
        headers={"Cache-Control": "public, max-age=86400"},
    )

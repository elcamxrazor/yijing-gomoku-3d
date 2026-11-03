from fastapi import APIRouter, Request, Response

from .schemas import Credentials, user_dict


router = APIRouter(prefix="/api/auth", tags=["auth"])


def _client_ip(request: Request) -> str:
    settings = request.app.state.settings
    if settings.trust_proxy:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


def _set_cookie(request: Request, response: Response, token: str) -> None:
    settings = request.app.state.settings
    response.set_cookie(
        settings.cookie_name,
        token,
        max_age=settings.session_ttl_hours * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


@router.post("/register")
def register(credentials: Credentials, request: Request, response: Response):
    auth = request.app.state.auth
    auth.limiter.check(f"register:{_client_ip(request)}")
    user, token = auth.register(credentials.username, credentials.password)
    _set_cookie(request, response, token)
    return {"user": user_dict(user)}


@router.post("/login")
def login(credentials: Credentials, request: Request, response: Response):
    auth = request.app.state.auth
    auth.limiter.check(f"login:{_client_ip(request)}:{credentials.username.casefold()}")
    user, token = auth.login(credentials.username, credentials.password)
    _set_cookie(request, response, token)
    return {"user": user_dict(user)}


@router.post("/logout")
def logout(request: Request, response: Response):
    settings = request.app.state.settings
    request.app.state.auth.logout(request.cookies.get(settings.cookie_name))
    response.delete_cookie(settings.cookie_name, path="/", httponly=True, samesite="lax")
    return {"ok": True}


@router.post("/guest")
def guest(request: Request, response: Response):
    # Guest accounts are cheap but still rate limited against trivial abuse.
    request.app.state.auth.guest_limiter.check(f"guest:{_client_ip(request)}")
    user, token = request.app.state.auth.guest()
    _set_cookie(request, response, token)
    return {"user": user_dict(user)}


@router.get("/me")
def me(request: Request):
    settings = request.app.state.settings
    user = request.app.state.auth.user_for_token(request.cookies.get(settings.cookie_name))
    return {"user": user_dict(user) if user else None}

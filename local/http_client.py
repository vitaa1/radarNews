from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

if __package__:
    from .errors import RadarError
else:
    from errors import RadarError


USER_AGENT = (
    "radarNewsLocal/1.0 "
    "(personal public-content monitor; official Supercell sources only)"
)


class RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Recusa redirecionamentos para não encaminhar o segredo do Worker."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        del req, fp, code, msg, headers, newurl
        raise RadarError("O Worker respondeu com redirecionamento; operação recusada.")


def request_json(
    url: str,
    *,
    method: str = "GET",
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout: int = 45,
) -> dict[str, Any]:
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        if token:
            opener = urllib.request.build_opener(RejectRedirectHandler())
            response_context = opener.open(request, timeout=timeout)
        else:
            response_context = urllib.request.urlopen(request, timeout=timeout)
        with response_context as response:
            raw = response.read(100_000).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        detail = error.read(2_000).decode("utf-8", errors="replace")
        raise RadarError(f"HTTP {error.code} em {url}: {detail}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RadarError(f"Falha de comunicação com {url}: {error}") from error

    try:
        result = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RadarError(f"Resposta JSON inválida recebida de {url}.") from error
    if not isinstance(result, dict):
        raise RadarError(f"Resposta inesperada recebida de {url}.")
    return result

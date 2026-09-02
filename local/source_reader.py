from __future__ import annotations

import re
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any

if __package__:
    from .errors import RadarError
    from .http_client import USER_AGENT
else:
    from errors import RadarError
    from http_client import USER_AGENT


ALLOWED_SOURCE_HOSTS = frozenset({"supercell.com"})


class SafeSourceRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Impede que uma fonte oficial redirecione a leitura para outro domínio."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        if not is_allowed_source_url(newurl):
            raise RadarError(
                "A fonte tentou redirecionar para um domínio não autorizado."
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ArticleTextExtractor(HTMLParser):
    """Extrai texto priorizando <main> ou <article>, sem executar HTML."""

    _SKIP_TAGS = {"script", "style", "svg", "nav", "footer", "noscript", "form"}
    _VOID_TAGS = {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
    _BLOCK_TAGS = {
        "article",
        "br",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "main",
        "p",
        "section",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._primary_depth = 0
        self._all: list[str] = []
        self._primary: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        tag = tag.lower()
        if self._skip_depth > 0:
            if tag not in self._VOID_TAGS:
                self._skip_depth += 1
            return
        if tag in self._SKIP_TAGS:
            self._skip_depth = 1
            return
        if tag in {"main", "article"}:
            self._primary_depth += 1
        if tag in self._BLOCK_TAGS:
            self._append("\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if self._skip_depth == 0 and tag.lower() in self._BLOCK_TAGS:
            self._append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self._skip_depth > 0:
            self._skip_depth -= 1
            return
        if tag in self._BLOCK_TAGS:
            self._append("\n")
        if tag in {"main", "article"} and self._primary_depth > 0:
            self._primary_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self._append(data)

    def _append(self, value: str) -> None:
        self._all.append(value)
        if self._primary_depth > 0:
            self._primary.append(value)

    def text(self) -> str:
        primary = normalize_text(" ".join(self._primary))
        all_text = normalize_text(" ".join(self._all))
        return primary if len(primary) >= 200 else all_text


def is_allowed_source_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and parsed.hostname in ALLOWED_SOURCE_HOSTS
        and parsed.username is None
        and parsed.password is None
        and parsed.port in (None, 443)
    )


def download_article(url: str) -> str:
    if not is_allowed_source_url(url):
        raise RadarError(
            "URL recusada: somente páginas HTTPS oficiais da Supercell são aceitas."
        )

    request = urllib.request.Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        opener = urllib.request.build_opener(SafeSourceRedirectHandler())
        with opener.open(request, timeout=45) as response:
            final_url = response.geturl()
            content_type = response.headers.get_content_type()
            if not is_allowed_source_url(final_url):
                raise RadarError("A fonte redirecionou para um domínio não autorizado.")
            if content_type not in {"text/html", "application/xhtml+xml"}:
                raise RadarError(f"A fonte devolveu o tipo inesperado {content_type}.")
            raw = response.read(1_500_001)
            charset = response.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as error:
        raise RadarError(f"A fonte oficial respondeu HTTP {error.code}.") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RadarError(f"Não foi possível abrir a fonte oficial: {error}") from error

    if len(raw) > 1_500_000:
        raise RadarError("A página excedeu o limite seguro de 1,5 MB.")
    page = raw.decode(charset, errors="replace")
    extractor = ArticleTextExtractor()
    extractor.feed(page)
    extractor.close()
    text = extractor.text()[:16_000]
    if len(text) < 200:
        raise RadarError(
            "Foi extraído pouco texto; a estrutura da página pode ter mudado."
        )
    return text


def normalize_text(value: str) -> str:
    value = re.sub(r"[\t\r\f\v ]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()

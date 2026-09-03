from __future__ import annotations

import io
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock, patch

from local.errors import RadarError
from local.http_client import USER_AGENT
from local.source_reader import (
    ArticleTextExtractor,
    SafeSourceRedirectHandler,
    download_article,
    is_allowed_source_url,
    normalize_text,
)


class FakeHeaders:
    def __init__(self, content_type: str, charset: str | None = None) -> None:
        self.content_type = content_type
        self.charset = charset

    def get_content_type(self) -> str:
        return self.content_type

    def get_content_charset(self) -> str | None:
        return self.charset


class FakeResponse:
    def __init__(
        self,
        body: bytes,
        *,
        final_url: str = "https://supercell.com/en/news/article/",
        content_type: str = "text/html",
        charset: str | None = None,
    ) -> None:
        self.body = body
        self.final_url = final_url
        self.headers = FakeHeaders(content_type, charset)
        self.read_size: int | None = None
        self.closed = False

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        self.closed = True

    def geturl(self) -> str:
        return self.final_url

    def read(self, size: int = -1) -> bytes:
        self.read_size = size
        return self.body[:size]


class SourceReaderTests(unittest.TestCase):
    def test_permite_apenas_urls_https_oficiais_sem_credenciais(self) -> None:
        valid_urls = (
            "https://supercell.com/en/news/article/",
            "https://supercell.com:443/en/news/article/?lang=pt#conteudo",
        )
        invalid_urls = (
            "http://supercell.com/en/news/article/",
            "https://evil.example/en/news/article/",
            "https://supercell.com.evil.example/article/",
            "https://usuario@supercell.com/article/",
            "https://usuario:senha@supercell.com/article/",
            "https://supercell.com:444/article/",
            "https://supercell.com:porta/article/",
            "https://[endereco-invalido/article/",
        )

        for url in valid_urls:
            with self.subTest(url=url):
                self.assertTrue(is_allowed_source_url(url))
        for url in invalid_urls:
            with self.subTest(url=url):
                self.assertFalse(is_allowed_source_url(url))

    def test_redirecionamento_recusa_dominio_externo(self) -> None:
        handler = SafeSourceRedirectHandler()
        with self.assertRaisesRegex(RadarError, "domínio não autorizado"):
            handler.redirect_request(
                req=object(),
                fp=None,
                code=302,
                msg="Found",
                headers={},
                newurl="https://evil.example/roubo",
            )

    def test_redirecionamento_oficial_delega_para_biblioteca_padrao(self) -> None:
        handler = SafeSourceRedirectHandler()
        expected = object()
        with patch.object(
            urllib.request.HTTPRedirectHandler,
            "redirect_request",
            return_value=expected,
        ) as parent_redirect:
            result = handler.redirect_request(
                req=object(),
                fp=None,
                code=301,
                msg="Moved",
                headers={},
                newurl="https://supercell.com/en/news/new-path/",
            )

        self.assertIs(result, expected)
        parent_redirect.assert_called_once()

    def test_extrator_prioriza_article_e_remove_elementos_ignorados(self) -> None:
        parser = ArticleTextExtractor()
        parser.feed(
            "<nav>menu secreto</nav><main><article><h1>Título oficial</h1><p>"
            + "Detalhe oficial. " * 20
            + "</p><script><span>alerta</span></script></article></main>"
            + "<footer>rodapé</footer>"
        )

        text = parser.text()
        self.assertIn("Título oficial", text)
        self.assertNotIn("menu secreto", text)
        self.assertNotIn("alerta", text)
        self.assertNotIn("rodapé", text)

    def test_extrator_usa_pagina_quando_conteudo_principal_e_curto(self) -> None:
        parser = ArticleTextExtractor()
        parser.feed(
            "<div>" + "Contexto público. " * 20 + "</div><main>Resumo curto<br/></main>"
        )

        text = parser.text()
        self.assertIn("Contexto público", text)
        self.assertIn("Resumo curto", text)

    def test_normaliza_espacos_sem_perder_paragrafos(self) -> None:
        self.assertEqual(normalize_text(" A   B \n\n\n C "), "A B\n\nC")

    def test_baixa_html_oficial_com_charset_declarado(self) -> None:
        html = (
            "<main><h1>Atualização</h1><p>"
            + "Informação oficial. " * 20
            + "</p></main>"
        )
        response = FakeResponse(html.encode("iso-8859-1"), charset="iso-8859-1")
        opener = Mock()
        opener.open.return_value = response

        with patch(
            "local.source_reader.urllib.request.build_opener",
            return_value=opener,
        ) as build_opener:
            text = download_article("https://supercell.com/en/news/article/")

        handler = build_opener.call_args.args[0]
        request = opener.open.call_args.args[0]
        headers = {name.lower(): value for name, value in request.header_items()}
        self.assertIsInstance(handler, SafeSourceRedirectHandler)
        self.assertIn("Atualização", text)
        self.assertEqual(headers["accept"], "text/html,application/xhtml+xml")
        self.assertEqual(headers["user-agent"], USER_AGENT)
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 45)
        self.assertEqual(response.read_size, 1_500_001)
        self.assertTrue(response.closed)

    def test_recusa_url_antes_de_abrir_conexao(self) -> None:
        with (
            patch("local.source_reader.urllib.request.build_opener") as build_opener,
            self.assertRaisesRegex(RadarError, "URL recusada"),
        ):
            download_article("https://evil.example/article/")

        build_opener.assert_not_called()

    def test_rejeita_respostas_inseguras_ou_sem_conteudo(self) -> None:
        cases = (
            (
                FakeResponse(b"conteudo", final_url="https://evil.example/article/"),
                "redirecionou",
            ),
            (FakeResponse(b"{}", content_type="application/json"), "tipo inesperado"),
            (FakeResponse(b"x" * 1_500_001), "limite seguro"),
            (FakeResponse(b"<main>curto</main>"), "pouco texto"),
            (
                FakeResponse(b"conteudo", charset="charset-inexistente"),
                "codificação de texto inválida",
            ),
        )

        for response, expected_message in cases:
            opener = Mock()
            opener.open.return_value = response
            with (
                self.subTest(expected_message=expected_message),
                patch(
                    "local.source_reader.urllib.request.build_opener",
                    return_value=opener,
                ),
                self.assertRaisesRegex(RadarError, expected_message),
            ):
                download_article("https://supercell.com/en/news/article/")

            self.assertTrue(response.closed)

    def test_converte_erros_http_e_de_comunicacao(self) -> None:
        errors = (
            (
                urllib.error.HTTPError(
                    "https://supercell.com/en/news/article/",
                    503,
                    "Unavailable",
                    hdrs=None,
                    fp=io.BytesIO(),
                ),
                "respondeu HTTP 503",
            ),
            (urllib.error.URLError("DNS indisponível"), "Não foi possível abrir"),
            (TimeoutError("tempo esgotado"), "Não foi possível abrir"),
        )

        for error, expected_message in errors:
            opener = Mock()
            opener.open.side_effect = error
            with (
                self.subTest(error=type(error).__name__),
                patch(
                    "local.source_reader.urllib.request.build_opener",
                    return_value=opener,
                ),
                self.assertRaisesRegex(RadarError, expected_message) as raised,
            ):
                download_article("https://supercell.com/en/news/article/")

            self.assertIs(raised.exception.__cause__, error)


if __name__ == "__main__":
    unittest.main()

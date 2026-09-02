from __future__ import annotations

import io
import json
import unittest
import urllib.error
from unittest.mock import Mock, patch

from local.errors import RadarError
from local.http_client import USER_AGENT, RejectRedirectHandler, request_json


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.read_size: int | None = None
        self.closed = False

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        self.closed = True

    def read(self, size: int = -1) -> bytes:
        self.read_size = size
        return self.body[:size]


class HttpClientTests(unittest.TestCase):
    def test_get_publico_envia_cabecalhos_e_limita_resposta(self) -> None:
        response = FakeResponse(b'{"ok": true}')
        with (
            patch(
                "local.http_client.urllib.request.urlopen", return_value=response
            ) as open_url,
            patch("local.http_client.urllib.request.build_opener") as build_opener,
        ):
            result = request_json("https://public.example/status", timeout=7)

        request = open_url.call_args.args[0]
        headers = {name.lower(): value for name, value in request.header_items()}
        self.assertEqual(result, {"ok": True})
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(headers["accept"], "application/json")
        self.assertEqual(headers["user-agent"], USER_AGENT)
        self.assertNotIn("authorization", headers)
        self.assertEqual(open_url.call_args.kwargs["timeout"], 7)
        self.assertEqual(response.read_size, 100_000)
        self.assertTrue(response.closed)
        build_opener.assert_not_called()

    def test_post_autenticado_usa_opener_sem_redirecionamento(self) -> None:
        response = FakeResponse(b'{"ok": true, "released": true}')
        opener = Mock()
        opener.open.return_value = response
        payload = {"mensagem": "alteração oficial"}

        with (
            patch(
                "local.http_client.urllib.request.build_opener",
                return_value=opener,
            ) as build_opener,
            patch("local.http_client.urllib.request.urlopen") as open_url,
        ):
            result = request_json(
                "https://worker.example/api/items/1/release",
                method="POST",
                token="segredo",
                payload=payload,
            )

        handler = build_opener.call_args.args[0]
        request = opener.open.call_args.args[0]
        headers = {name.lower(): value for name, value in request.header_items()}
        self.assertIsInstance(handler, RejectRedirectHandler)
        self.assertEqual(result, {"ok": True, "released": True})
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(headers["authorization"], "Bearer segredo")
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(json.loads(request.data.decode("utf-8")), payload)
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 45)
        open_url.assert_not_called()

    def test_recusa_redirecionamento_em_chamada_autenticada(self) -> None:
        handler = RejectRedirectHandler()
        with self.assertRaisesRegex(RadarError, "redirecionamento"):
            handler.redirect_request(
                req=object(),
                fp=None,
                code=302,
                msg="Found",
                headers={},
                newurl="https://destino.example/roubo",
            )

    def test_converte_erro_http_com_detalhe_da_resposta(self) -> None:
        error = urllib.error.HTTPError(
            "https://worker.example/status",
            403,
            "Forbidden",
            hdrs=None,
            fp=io.BytesIO(b"token invalido"),
        )
        with (
            patch("local.http_client.urllib.request.urlopen", side_effect=error),
            self.assertRaisesRegex(RadarError, "HTTP 403.*token invalido") as raised,
        ):
            request_json("https://worker.example/status")

        self.assertIs(raised.exception.__cause__, error)

    def test_converte_falhas_de_comunicacao(self) -> None:
        errors = (
            urllib.error.URLError("DNS indisponivel"),
            TimeoutError("tempo esgotado"),
        )
        for error in errors:
            with (
                self.subTest(error=type(error).__name__),
                patch("local.http_client.urllib.request.urlopen", side_effect=error),
                self.assertRaisesRegex(RadarError, "Falha de comunicação") as raised,
            ):
                request_json("https://worker.example/status")

            self.assertIs(raised.exception.__cause__, error)

    def test_rejeita_json_invalido(self) -> None:
        response = FakeResponse(b"nao e json")
        with (
            patch("local.http_client.urllib.request.urlopen", return_value=response),
            self.assertRaisesRegex(RadarError, "JSON inválida") as raised,
        ):
            request_json("https://worker.example/status")

        self.assertIsInstance(raised.exception.__cause__, json.JSONDecodeError)
        self.assertTrue(response.closed)

    def test_rejeita_json_que_nao_seja_objeto(self) -> None:
        response = FakeResponse(b"[]")
        with (
            patch("local.http_client.urllib.request.urlopen", return_value=response),
            self.assertRaisesRegex(RadarError, "Resposta inesperada"),
        ):
            request_json("https://worker.example/status")


if __name__ == "__main__":
    unittest.main()

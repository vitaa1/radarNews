from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from local.configuration import (
    load_channel_profile,
    load_dotenv,
    positive_int_env,
    validate_configuration,
)
from local.errors import RadarError
from local.processador import main


class ConfigurationTests(unittest.TestCase):
    def test_urls_malformadas_viram_erro_de_configuracao(self) -> None:
        for worker, ollama in (
            ("https://[invalido", "http://127.0.0.1:11434"),
            ("https://radar.example", "http://[invalido"),
            ("https://radar.example", "http://:11434"),
        ):
            with (
                self.subTest(worker=worker, ollama=ollama),
                self.assertRaises(RadarError),
            ):
                validate_configuration(worker, "s" * 32, ollama, "modelo-teste")

    def test_arquivos_com_utf8_invalido_viram_erro_de_configuracao(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for loader, name in (
                (load_dotenv, ".env"),
                (load_channel_profile, "perfil.json"),
            ):
                path = Path(directory) / name
                path.write_bytes(b"\xff\xfe\xfa")
                with self.subTest(name=name), self.assertRaises(RadarError):
                    loader(path)

    def test_falha_de_leitura_nao_expoe_detalhes_do_sistema(self) -> None:
        for loader in (load_dotenv, load_channel_profile):
            with (
                self.subTest(loader=loader.__name__),
                patch.object(
                    Path, "read_text", side_effect=PermissionError("DETALHE_PRIVADO")
                ),
                self.assertRaises(RadarError) as raised,
            ):
                loader(Path("configuracao"))
            self.assertNotIn("DETALHE_PRIVADO", str(raised.exception))

    def test_main_recusa_url_malformada_antes_de_processar(self) -> None:
        errors = io.StringIO()
        with (
            patch.dict(
                os.environ,
                {"WORKER_URL": "https://[invalido", "SHARED_SECRET": "s" * 32},
                clear=True,
            ),
            patch.object(sys, "argv", ["processador.py", "--once"]),
            patch("local.processador.load_dotenv"),
            patch("local.processador.load_channel_profile", return_value=None),
            patch("local.processador.process_once") as process,
            redirect_stderr(errors),
        ):
            result = main()
        self.assertEqual(result, 2)
        self.assertIn("Configuração inválida", errors.getvalue())
        self.assertNotIn("Traceback", errors.getvalue())
        process.assert_not_called()

    def test_main_recusa_arquivo_ilegivel_antes_de_acessar_servicos(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for name in (".env", "perfil-canal.json"):
                with self.subTest(name=name):
                    path = base / name
                    path.write_bytes(b"\xff")
                    errors = io.StringIO()
                    with (
                        patch("local.processador.BASE_DIR", base),
                        patch.dict(os.environ, {}, clear=True),
                        patch.object(sys, "argv", ["processador.py", "--once"]),
                        patch("local.processador.process_once") as process,
                        redirect_stderr(errors),
                    ):
                        result = main()
                    self.assertEqual(result, 2)
                    self.assertIn(name, errors.getvalue())
                    self.assertIn("UTF-8", errors.getvalue())
                    self.assertNotIn("Traceback", errors.getvalue())
                    process.assert_not_called()
                    path.unlink()

    def test_configuracoes_validas_preservam_https_ipv6_e_proxy_local(self) -> None:
        for worker, ollama in (
            ("https://radar.example", "http://127.0.0.1:11434"),
            ("https://radar.example:443/", "https://ollama.example/proxy"),
            ("https://radar.example", "http://[::1]:11434"),
        ):
            with self.subTest(worker=worker, ollama=ollama):
                validate_configuration(worker, "s" * 24, ollama, "modelo-teste")

    def test_rejeita_destinos_e_portas_invalidas_sem_repetir_url(self) -> None:
        urls = (
            "ftp://radar.example",
            "http://radar.example",
            "https://",
            "https://usuario:MARCADOR_PRIVADO@radar.example",
            "https://radar.example#fragmento",
            "https://radar.example:abc",
            "https://radar.example:65536",
        )
        for url in urls:
            with self.subTest(worker=url), self.assertRaises(RadarError) as raised:
                validate_configuration(
                    url, "s" * 24, "http://localhost:11434", "modelo"
                )
            self.assertNotIn("MARCADOR_PRIVADO", str(raised.exception))
        for url in (
            "ftp://localhost",
            "http://",
            "http://localhost:0",
            "http://localhost:65536",
            "http://localhost:abc",
            "http://usuario:MARCADOR_PRIVADO@localhost",
            "http://localhost?destino=outro",
            "http://localhost#fragmento",
        ):
            with self.subTest(ollama=url), self.assertRaises(RadarError) as raised:
                validate_configuration("https://radar.example", "s" * 24, url, "modelo")
            self.assertNotIn("MARCADOR_PRIVADO", str(raised.exception))

    def test_rejeita_segredo_curto_e_modelo_vazio(self) -> None:
        for secret, model in (("s" * 23, "modelo"), ("s" * 24, "")):
            with self.subTest(model=model), self.assertRaises(RadarError):
                validate_configuration(
                    "https://radar.example", secret, "http://localhost:11434", model
                )

    def test_arquivos_ausentes_sao_opcionais(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {}, clear=True),
        ):
            path = Path(directory) / "ausente"
            self.assertIsNone(load_dotenv(path))
            self.assertIsNone(load_channel_profile(path))
            self.assertEqual(dict(os.environ), {})
            self.assertFalse(path.exists())

    def test_dotenv_preserva_ambiente_e_carrega_valores_com_aspas(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "\ufeff# comentário\n\nEXISTENTE=arquivo\n NOVA = 'valor=composto'\n DUPLA=\"ação\"\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"EXISTENTE": "sistema"}, clear=True):
                load_dotenv(path)
                self.assertEqual(
                    dict(os.environ),
                    {"EXISTENTE": "sistema", "NOVA": "valor=composto", "DUPLA": "ação"},
                )

    def test_dotenv_rejeita_linhas_invalidas_sem_expor_valores(self) -> None:
        for content in (
            "SEM_IGUAL_MARCADOR_PRIVADO",
            "CHAVE-INVALIDA=MARCADOR_PRIVADO",
        ):
            with (
                self.subTest(content=content),
                patch.object(Path, "read_text", return_value=content),
                patch.dict(os.environ, {}, clear=True),
                self.assertRaises(RadarError) as raised,
            ):
                load_dotenv(Path(".env"))
            self.assertNotIn("MARCADOR_PRIVADO", str(raised.exception))

    def test_inteiros_usam_padrao_e_respeitam_limites(self) -> None:
        for raw, expected in (
            (None, 60),
            (" 45 ", 45),
            ("0", 30),
            ("-2", 30),
            ("9999", 3600),
        ):
            environment = {} if raw is None else {"LOCAL_POLL_SECONDS": raw}
            with self.subTest(raw=raw), patch.dict(os.environ, environment, clear=True):
                self.assertEqual(
                    positive_int_env("LOCAL_POLL_SECONDS", 60, 30, 3600), expected
                )
        with (
            patch.dict(os.environ, {"LOCAL_POLL_SECONDS": "1.5"}, clear=True),
            self.assertRaises(RadarError),
        ):
            positive_int_env("LOCAL_POLL_SECONDS", 60, 30, 3600)

    def test_perfil_valido_limita_textos_e_ignora_campos_desconhecidos(self) -> None:
        raw = {
            "nome_canal": " n" + "x" * 110,
            "posicionamento": "p" * 510,
            "publico_principal": "a" * 510,
            "tom_de_voz": "t" * 310,
            "diferenciais": ["d" * 210],
            "evitar": [" e "],
            "desconhecido": "ignorar",
        }
        with patch.object(Path, "read_text", return_value=json.dumps(raw)):
            profile = load_channel_profile(Path("perfil.json"))
        self.assertEqual(len(profile["nome_canal"]), 100)
        self.assertEqual(len(profile["posicionamento"]), 500)
        self.assertEqual(len(profile["publico_principal"]), 500)
        self.assertEqual(len(profile["tom_de_voz"]), 300)
        self.assertEqual(profile["diferenciais"], ["d" * 200])
        self.assertEqual(profile["evitar"], ["e"])
        self.assertNotIn("desconhecido", profile)

    def test_perfil_invalido_retorna_erro_controlado(self) -> None:
        contents = (
            "{",
            "[]",
            "null",
            "{}",
            '{"nome_canal":1}',
            '{"tom_de_voz":" "}',
            '{"diferenciais":"texto"}',
            '{"evitar":[null]}',
            json.dumps({"diferenciais": ["item"] * 6}),
        )
        for content in contents:
            with (
                self.subTest(content=content),
                patch.object(Path, "read_text", return_value=content),
                self.assertRaises(RadarError),
            ):
                load_channel_profile(Path("perfil.json"))


if __name__ == "__main__":
    unittest.main()

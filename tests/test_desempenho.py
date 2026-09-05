from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from local.desempenho import (
    build_performance_context,
    get_result,
    interactive_result,
    main,
    normalize_youtube_url,
    optional_int,
    save_result,
    validate_result,
)


def valid_result(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "youtube_url": "https://youtu.be/dQw4w9WgXcQ?t=10",
        "title": "Teste de atualização",
        "format": "Short",
        "title_style": "Equilibrado",
        "published_on": "2026-08-30",
        "views_48h": 120,
        "views_7d": "",
        "ctr_percent": "5,5",
        "retention_30s_percent": 62,
        "average_percentage_viewed": 105,
        "subscribers_gained": 3,
        "notes": "O gancho foi direto.",
    }
    value.update(overrides)
    return value


class DesempenhoTests(unittest.TestCase):
    def test_contadores_invalidos_sao_recusados_antes_de_abrir_banco(self) -> None:
        for field in ("views_48h", "views_7d", "subscribers_gained"):
            for value in (
                True,
                False,
                1.0,
                1.5,
                float("inf"),
                float("nan"),
                2**63,
                str(2**63),
            ):
                with (
                    self.subTest(field=field, value=value),
                    patch("local.desempenho.connect_database") as connect,
                    self.assertRaises(ValueError),
                ):
                    save_result(valid_result(**{field: value}))
                connect.assert_not_called()

    def test_contador_opcional_preserva_vazio_zero_e_limite_sqlite(self) -> None:
        for value, expected in (
            (None, None),
            ("", None),
            (0, 0),
            (" 0 ", 0),
            (42, 42),
            ("42", 42),
            (2**63 - 1, 2**63 - 1),
            (str(2**63 - 1), 2**63 - 1),
        ):
            with self.subTest(value=value):
                self.assertEqual(optional_int(value, "Views"), expected)

    def test_contador_rejeita_negativos_fracoes_e_tipos_incompativeis(self) -> None:
        for value in (-1, "-1", "1.5", "1,5", "inválido", [], {}, b"42"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                optional_int(value, "Views")

    def test_limite_sqlite_e_zero_sao_persistidos_sem_perder_precisao(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "desempenho.db"
            save_result(
                valid_result(
                    views_48h=2**63 - 1, views_7d=str(2**63 - 1), subscribers_gained=0
                ),
                path,
            )
            stored = get_result(valid_result()["youtube_url"], path)
        self.assertEqual(stored["views_48h"], 2**63 - 1)
        self.assertEqual(stored["views_7d"], 2**63 - 1)
        self.assertEqual(stored["subscribers_gained"], 0)

    def test_atualizacao_invalida_preserva_registro_existente(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "desempenho.db"
            initial = valid_result()
            save_result(initial, path)
            before = get_result(initial["youtube_url"], path)
            with self.assertRaises(ValueError):
                save_result(
                    valid_result(title="Título alterado", views_7d=str(2**63)), path
                )
            after = get_result(initial["youtube_url"], path)
        self.assertEqual(after, before)

    def test_atualizacao_com_zero_substitui_valor_anterior(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "desempenho.db"
            save_result(valid_result(), path)
            save_result(valid_result(views_48h=0, subscribers_gained="0"), path)
            stored = get_result(valid_result()["youtube_url"], path)
        self.assertEqual(stored["views_48h"], 0)
        self.assertEqual(stored["subscribers_gained"], 0)

    def test_cli_rejeita_contador_excessivo_sem_criar_banco(self) -> None:
        answers = [
            "https://youtu.be/dQw4w9WgXcQ",
            "Título de teste",
            "Short",
            "Equilibrado",
            "2026-08-30",
            str(2**63),
            "",
            "",
            "",
            "",
            "",
            "",
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "desempenho.db"
            output = io.StringIO()
            with (
                patch.object(sys, "argv", ["desempenho.py", "registrar"]),
                patch("builtins.input", side_effect=answers),
                patch(
                    "local.desempenho.interactive_result",
                    side_effect=lambda: interactive_result(path),
                ),
                redirect_stdout(output),
            ):
                result = main()
            self.assertFalse(path.exists())
        self.assertEqual(result, 1)
        self.assertIn("Views em 48h não pode exceder", output.getvalue())
        self.assertNotIn("Resultado salvo", output.getvalue())
        self.assertNotIn("Traceback", output.getvalue())

    def test_normaliza_formatos_publicos_do_mesmo_video(self) -> None:
        expected = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        self.assertEqual(
            normalize_youtube_url("https://youtu.be/dQw4w9WgXcQ?t=2"), expected
        )
        self.assertEqual(
            normalize_youtube_url(
                "https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share"
            ),
            expected,
        )
        self.assertEqual(
            normalize_youtube_url(
                "https://youtube.com/watch?v=dQw4w9WgXcQ&utm_source=x"
            ),
            expected,
        )

    def test_rejeita_url_que_nao_identifica_video(self) -> None:
        for url in (
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "http://youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/@BrawlStars",
            "https://youtube.com/watch?v=curto",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                normalize_youtube_url(url)

    def test_salva_e_atualiza_mesmo_video_sem_apagar_metricas_anteriores(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "desempenho.db"
            save_result(valid_result(), path)
            save_result(
                valid_result(
                    views_48h="",
                    views_7d=410,
                    ctr_percent="",
                    retention_30s_percent="",
                    average_percentage_viewed="",
                    subscribers_gained=7,
                    notes="",
                ),
                path,
            )
            stored = get_result("https://youtube.com/watch?v=dQw4w9WgXcQ", path)
        self.assertIsNotNone(stored)
        self.assertEqual(stored["views_48h"], 120)
        self.assertEqual(stored["views_7d"], 410)
        self.assertEqual(stored["ctr_percent"], 5.5)
        self.assertEqual(stored["subscribers_gained"], 7)
        self.assertEqual(stored["notes"], "O gancho foi direto.")

    def test_contexto_mostra_amostra_metricas_e_alerta_de_causalidade(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "desempenho.db"
            save_result(valid_result(), path)
            context = build_performance_context(path)
        self.assertIn("Amostra registrada: 1 vídeo(s)", context)
        self.assertIn("Não presuma causalidade", context)
        self.assertIn("Médias recentes de Short", context)
        self.assertIn("CTR 5.5% (n=1)", context)
        self.assertIn("título Equilibrado", context)
        self.assertIn("nota=O gancho foi direto", context)

    def test_contexto_vazio_nao_cria_banco(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "desempenho.db"
            self.assertEqual(build_performance_context(path), "")
            self.assertFalse(path.exists())

    def test_rejeita_percentual_fora_do_intervalo(self) -> None:
        with self.assertRaisesRegex(ValueError, "entre 0 e 100"):
            validate_result(valid_result(ctr_percent=101))

    def test_rejeita_data_futura(self) -> None:
        with self.assertRaisesRegex(ValueError, "não pode estar no futuro"):
            validate_result(valid_result(published_on="2999-01-01"))


if __name__ == "__main__":
    unittest.main()

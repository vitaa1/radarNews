from __future__ import annotations

import io
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from local.errors import RadarError
from local.processador import main, process_once

WORKER_URL = "https://radar.example"
SECRET = "s" * 32
OLLAMA_URL = "http://127.0.0.1:11434"
MODEL = "gemma3:4b"


def item(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "id": "a" * 64,
        "source": "Supercell",
        "title": "Atualização oficial",
        "url": "https://supercell.com/en/news/update/",
    }
    value.update(overrides)
    return value


def claim_result(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "claimToken": "claim-token",
        "items": [item()],
        "editorialHistory": [],
    }
    value.update(overrides)
    return value


def run_once(*, dry_run: bool = False) -> tuple[int, int]:
    return process_once(
        WORKER_URL,
        SECRET,
        OLLAMA_URL,
        MODEL,
        batch_size=1,
        dry_run=dry_run,
        channel_profile={"tom_de_voz": "Direto"},
        performance_context="Amostra registrada: 2 vídeos.",
    )


class ProcessorFlowTests(unittest.TestCase):
    def test_fila_vazia_encerra_sem_falha(self) -> None:
        output = io.StringIO()
        with (
            patch(
                "local.processador.request_json",
                return_value=claim_result(items=[]),
            ),
            redirect_stdout(output),
        ):
            result = run_once()

        self.assertEqual(result, (0, 0))
        self.assertIn("Nenhuma pauta pendente", output.getvalue())

    def test_rejeita_reserva_em_formato_inesperado(self) -> None:
        invalid_results = (
            claim_result(claimToken=None),
            claim_result(items=None),
            claim_result(items=[item(), item(id="b" * 64)]),
        )
        for result in invalid_results:
            with (
                self.subTest(result=result),
                patch("local.processador.request_json", return_value=result),
                self.assertRaises(RadarError),
            ):
                run_once()

    def test_item_sem_identificador_interrompe_lote(self) -> None:
        errors = io.StringIO()
        with (
            patch(
                "local.processador.request_json",
                return_value=claim_result(items=[{"title": "Sem ID"}]),
            ),
            redirect_stderr(errors),
        ):
            result = run_once()

        self.assertEqual(result, (0, 1))
        self.assertIn("Item inválido", errors.getvalue())

    def test_dry_run_exibe_analise_e_devolve_item_sem_contar_falha(self) -> None:
        analysis = {"resumo": "Resultado local"}
        output = io.StringIO()
        with (
            patch(
                "local.processador.request_json",
                side_effect=[claim_result(), {"released": True}],
            ) as request,
            patch("local.processador.download_article", return_value="Texto oficial"),
            patch("local.processador.call_ollama", return_value=analysis),
            redirect_stdout(output),
        ):
            result = run_once(dry_run=True)

        self.assertEqual(result, (1, 0))
        self.assertIn('"resumo": "Resultado local"', output.getvalue())
        release_payload = request.call_args_list[1].kwargs["payload"]
        self.assertFalse(release_payload["countFailure"])
        self.assertEqual(release_payload["error"], "Teste --dry-run")

    def test_conclusao_informa_entrega_imediata(self) -> None:
        output = io.StringIO()
        with (
            patch(
                "local.processador.request_json",
                side_effect=[claim_result(), {"ok": True, "delivered": True}],
            ),
            patch("local.processador.download_article", return_value="Texto oficial"),
            patch("local.processador.call_ollama", return_value={"resumo": "ok"}),
            redirect_stdout(output),
        ):
            result = run_once()

        self.assertEqual(result, (1, 0))
        self.assertIn("Pauta enviada ao Telegram", output.getvalue())

    def test_conclusao_informa_reagendamento_do_telegram(self) -> None:
        output = io.StringIO()
        with (
            patch(
                "local.processador.request_json",
                side_effect=[
                    claim_result(),
                    {"ok": True, "delivered": False, "deliveryPending": True},
                ],
            ),
            patch("local.processador.download_article", return_value="Texto oficial"),
            patch("local.processador.call_ollama", return_value={"resumo": "ok"}),
            redirect_stdout(output),
        ):
            result = run_once()

        self.assertEqual(result, (1, 0))
        self.assertIn("Telegram será tentado novamente", output.getvalue())

    def test_resposta_ambigua_na_conclusao_e_tratada_como_falha(self) -> None:
        invalid_deliveries = (
            {"ok": True},
            {"ok": True, "deliveryPending": True},
            {"ok": True, "delivered": None, "deliveryPending": True},
            {"ok": False, "delivered": True},
            {"ok": False, "deliveryPending": True},
            {"ok": True, "delivered": False, "deliveryPending": False},
            {"ok": True, "delivered": True, "deliveryPending": True},
            {"ok": True, "delivered": "true"},
            {"ok": True, "deliveryPending": 1},
            {"ok": 1, "delivered": True},
        )
        for delivery in invalid_deliveries:
            errors = io.StringIO()
            with (
                self.subTest(delivery=delivery),
                patch(
                    "local.processador.request_json",
                    side_effect=[claim_result(), delivery, {"released": True}],
                ) as request,
                patch(
                    "local.processador.download_article", return_value="Texto oficial"
                ),
                patch("local.processador.call_ollama", return_value={"resumo": "ok"}),
                redirect_stderr(errors),
            ):
                result = run_once()

            self.assertEqual(result, (0, 1))
            self.assertIn("não confirmou", errors.getvalue())
            self.assertTrue(request.call_args_list[2].args[0].endswith("/release"))

    def test_falha_de_processamento_devolve_item_e_registra_dead_letter(self) -> None:
        errors = io.StringIO()
        with (
            patch(
                "local.processador.request_json",
                side_effect=[claim_result(), {"released": True, "deadLettered": True}],
            ) as request,
            patch(
                "local.processador.download_article",
                side_effect=RadarError("fonte indisponível"),
            ),
            redirect_stderr(errors),
        ):
            result = run_once()

        self.assertEqual(result, (0, 1))
        self.assertIn("fonte indisponível", errors.getvalue())
        self.assertIn("fila de falhas", errors.getvalue())
        release_payload = request.call_args_list[1].kwargs["payload"]
        self.assertTrue(release_payload["countFailure"])
        self.assertEqual(release_payload["error"], "fonte indisponível")

    def test_falha_ao_devolver_item_nao_oculta_erro_original(self) -> None:
        errors = io.StringIO()
        with (
            patch(
                "local.processador.request_json",
                side_effect=[claim_result(), RadarError("release indisponível")],
            ),
            patch(
                "local.processador.download_article",
                side_effect=RadarError("fonte indisponível"),
            ),
            redirect_stderr(errors),
        ):
            result = run_once()

        self.assertEqual(result, (0, 1))
        self.assertIn("fonte indisponível", errors.getvalue())
        self.assertIn("release indisponível", errors.getvalue())

    def test_item_sem_url_e_devolvido_a_fila(self) -> None:
        errors = io.StringIO()
        with (
            patch(
                "local.processador.request_json",
                side_effect=[
                    claim_result(items=[item(url=None)]),
                    {"released": True},
                ],
            ) as request,
            redirect_stderr(errors),
        ):
            result = run_once()

        self.assertEqual(result, (0, 1))
        self.assertIn(
            "URL válida", request.call_args_list[1].kwargs["payload"]["error"]
        )


class ProcessorMainTests(unittest.TestCase):
    def main_context(self, *args: str):
        environment = {
            "WORKER_URL": WORKER_URL,
            "SHARED_SECRET": SECRET,
            "OLLAMA_URL": OLLAMA_URL,
            "OLLAMA_MODEL": MODEL,
            "LOCAL_POLL_SECONDS": "30",
            "LOCAL_BATCH_SIZE": "1",
        }
        return (
            patch.dict(os.environ, environment, clear=True),
            patch.object(sys, "argv", ["processador.py", *args]),
            patch("local.processador.load_dotenv"),
            patch("local.processador.load_channel_profile", return_value={}),
            patch("local.processador.validate_configuration"),
        )

    def test_configuracao_invalida_retorna_codigo_dois(self) -> None:
        environment, argv, dotenv, profile, validate = self.main_context("--once")
        errors = io.StringIO()
        with (
            environment,
            argv,
            dotenv,
            profile,
            validate as validation,
            redirect_stderr(errors),
        ):
            validation.side_effect = RadarError("segredo ausente")
            result = main()

        self.assertEqual(result, 2)
        self.assertIn("Configuração inválida", errors.getvalue())
        validation.assert_called_once()

    def test_execucao_unica_reflete_sucesso_ou_falha(self) -> None:
        for process_result, expected in (((1, 0), 0), ((0, 1), 1)):
            environment, argv, dotenv, profile, validate = self.main_context("--once")
            with (
                self.subTest(process_result=process_result),
                environment,
                argv,
                dotenv,
                profile,
                validate,
                patch("local.processador.build_performance_context", return_value=""),
                patch("local.processador.process_once", return_value=process_result),
            ):
                self.assertEqual(main(), expected)

    def test_falha_no_historico_nao_impede_execucao_unica(self) -> None:
        environment, argv, dotenv, profile, validate = self.main_context("--once")
        errors = io.StringIO()
        with (
            environment,
            argv,
            dotenv,
            profile,
            validate,
            patch(
                "local.processador.build_performance_context",
                side_effect=OSError("banco bloqueado"),
            ),
            patch("local.processador.process_once", return_value=(1, 0)) as process,
            redirect_stderr(errors),
        ):
            result = main()

        self.assertEqual(result, 0)
        self.assertIn("histórico de desempenho", errors.getvalue())
        self.assertEqual(process.call_args.args[-1], "")

    def test_falha_do_ciclo_em_execucao_unica_retorna_um(self) -> None:
        environment, argv, dotenv, profile, validate = self.main_context("--once")
        errors = io.StringIO()
        with (
            environment,
            argv,
            dotenv,
            profile,
            validate,
            patch("local.processador.build_performance_context", return_value=""),
            patch(
                "local.processador.process_once",
                side_effect=RadarError("Worker indisponível"),
            ),
            redirect_stderr(errors),
        ):
            result = main()

        self.assertEqual(result, 1)
        self.assertIn("Falha do ciclo", errors.getvalue())

    def test_modo_continuo_aguarda_e_encerra_com_ctrl_c(self) -> None:
        environment, argv, dotenv, profile, validate = self.main_context()
        output = io.StringIO()
        with (
            environment,
            argv,
            dotenv,
            profile,
            validate,
            patch("local.processador.build_performance_context", return_value=""),
            patch("local.processador.process_once", return_value=(0, 0)),
            patch(
                "local.processador.time.sleep", side_effect=KeyboardInterrupt
            ) as sleep,
            redirect_stdout(output),
        ):
            result = main()

        self.assertEqual(result, 0)
        sleep.assert_called_once_with(30)
        self.assertIn("encerrado pelo usuário", output.getvalue())


if __name__ == "__main__":
    unittest.main()

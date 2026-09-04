from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from local.editorial import (
    ANALYSIS_SCHEMA,
    build_messages,
    call_ollama,
    normalize_editorial_history,
)
from local.errors import RadarError


def valid_analysis() -> dict[str, object]:
    return {
        "resumo": "Resumo factual com contexto suficiente sobre o anúncio oficial.",
        "classificacao": "Comunicado",
        "prioridade": "Média",
        "publico_alvo": "Jogadores interessados nas novidades oficiais.",
        "angulo_diferenciado": "Explicar o impacto prático para jogadores casuais.",
        "gancho_abertura": "Esta mudança oficial merece atenção dos jogadores.",
        "titulos": ["Primeiro título", "Segundo título", "Terceiro título"],
        "conceito_thumbnail": "Imagem oficial com texto curto e legível.",
        "estrategia_retencao": "Mostrar a mudança, contextualizar e concluir com a fonte.",
        "experimento_crescimento": "Testar o título e comparar a taxa de cliques.",
        "roteiro_curto": "Este é um roteiro factual para narração. " * 10,
        "pontos_a_verificar": "Conferir a fonte oficial",
    }


class EditorialHistoryTests(unittest.TestCase):
    def test_limita_historico_e_tamanho_dos_campos(self) -> None:
        raw = [
            {"title": " t" + "x" * 200, "classification": "c" * 40, "angle": "a" * 300}
            for _ in range(9)
        ]
        history = normalize_editorial_history(raw)

        self.assertEqual(len(history), 8)
        for entry in history:
            self.assertEqual(entry["titulo"], "t" + "x" * 179)
            self.assertEqual(entry["classificacao"], "c" * 30)
            self.assertEqual(entry["angulo"], "a" * 280)
        self.assertEqual(len(raw), 9)
        self.assertTrue(raw[0]["title"].startswith(" "))

    def test_ignora_entradas_invalidas_e_preserva_ordem_das_validas(self) -> None:
        history = normalize_editorial_history(
            [
                None,
                {"title": " ", "angle": "Recorte"},
                {"title": "Sem ângulo", "angle": 1},
                {
                    "title": " Primeiro ",
                    "classification": None,
                    "angle": " Recorte um ",
                },
                {
                    "title": "Segundo",
                    "classification": " Evento ",
                    "angle": "Recorte dois",
                },
            ]
        )
        self.assertEqual(
            history,
            [
                {"titulo": "Primeiro", "classificacao": "", "angulo": "Recorte um"},
                {
                    "titulo": "Segundo",
                    "classificacao": "Evento",
                    "angulo": "Recorte dois",
                },
            ],
        )

    def test_contexto_editorial_fica_na_mensagem_de_dados(self) -> None:
        baseline = build_messages({}, "Artigo oficial")
        messages = build_messages(
            {},
            "Artigo oficial",
            {"tom_de_voz": "Preferência de teste"},
            [{"title": "Anterior", "angle": "Recorte anterior"}],
            "m" * 4_000 + "FIM_FORA_DO_LIMITE",
        )
        self.assertEqual(messages[0], baseline[0])
        self.assertEqual([entry["role"] for entry in messages], ["system", "user"])
        self.assertIn("Preferência de teste", messages[1]["content"])
        self.assertIn("Recorte anterior", messages[1]["content"])
        self.assertIn("m" * 4_000, messages[1]["content"])
        self.assertNotIn("FIM_FORA_DO_LIMITE", messages[1]["content"])


class OllamaTests(unittest.TestCase):
    def test_envia_prompt_e_contrato_e_valida_resposta(self) -> None:
        messages = build_messages({}, "Artigo oficial")
        analysis = valid_analysis()
        with patch(
            "local.editorial.request_json",
            return_value={"message": {"content": json.dumps(analysis)}},
        ) as request:
            result = call_ollama("http://127.0.0.1:11434/", "modelo-teste", messages)

        self.assertEqual(result["roteiro_curto"], analysis["roteiro_curto"].strip())
        self.assertEqual(result["titulos"], analysis["titulos"])
        self.assertEqual(request.call_args.args, ("http://127.0.0.1:11434/api/chat",))
        arguments = request.call_args.kwargs
        self.assertEqual(arguments["method"], "POST")
        self.assertEqual(arguments["timeout"], 600)
        self.assertNotIn("token", arguments)
        self.assertEqual(arguments["payload"]["model"], "modelo-teste")
        self.assertIs(arguments["payload"]["stream"], False)
        self.assertEqual(arguments["payload"]["messages"], messages)
        self.assertEqual(arguments["payload"]["format"], ANALYSIS_SCHEMA)

    def test_aceita_json_cercado_por_bloco_markdown(self) -> None:
        for marker in ("", "json", "JSON"):
            content = f" ```{marker}\n{json.dumps(valid_analysis())}\n``` "
            with (
                self.subTest(marker=marker),
                patch(
                    "local.editorial.request_json",
                    return_value={"message": {"content": content}},
                ),
            ):
                result = call_ollama("http://127.0.0.1:11434", "modelo-teste", [])
            self.assertEqual(result["classificacao"], "Comunicado")

    def test_rejeita_resposta_sem_conteudo_textual(self) -> None:
        for response in (
            {},
            {"message": []},
            {"message": {}},
            {"message": {"content": 1}},
            {"message": {"content": " \n "}},
        ):
            with (
                self.subTest(response=response),
                patch("local.editorial.request_json", return_value=response),
                self.assertRaisesRegex(RadarError, "não devolveu conteúdo"),
            ):
                call_ollama("http://127.0.0.1:11434", "modelo-teste", [])

    def test_rejeita_json_invalido_sem_expor_conteudo_do_modelo(self) -> None:
        for content in (
            "CONTEUDO_PRIVADO_INVALIDO",
            "```json\n{\n```",
            "{} texto extra",
        ):
            with (
                self.subTest(content=content),
                patch(
                    "local.editorial.request_json",
                    return_value={"message": {"content": content}},
                ),
                self.assertRaises(RadarError) as raised,
            ):
                call_ollama("http://127.0.0.1:11434", "modelo-teste", [])
            self.assertEqual(
                str(raised.exception), "O modelo não devolveu JSON válido."
            )

    def test_rejeita_json_valido_fora_do_contrato_editorial(self) -> None:
        invalid = (
            [],
            None,
            {},
            {**valid_analysis(), "titulos": ["Título único"]},
            {**valid_analysis(), "prioridade": "Urgente"},
            {**valid_analysis(), "resumo": "Curto"},
        )
        for analysis in invalid:
            with (
                self.subTest(analysis=analysis),
                patch(
                    "local.editorial.request_json",
                    return_value={"message": {"content": json.dumps(analysis)}},
                ),
                self.assertRaises(RadarError),
            ):
                call_ollama("http://127.0.0.1:11434", "modelo-teste", [])

    def test_propaga_falha_http_sem_repetir_chamada(self) -> None:
        failure = RadarError("Ollama indisponível")
        with (
            patch("local.editorial.request_json", side_effect=failure) as request,
            self.assertRaises(RadarError) as raised,
        ):
            call_ollama("http://127.0.0.1:11434", "modelo-teste", [])
        self.assertIs(raised.exception, failure)
        request.assert_called_once()


if __name__ == "__main__":
    unittest.main()

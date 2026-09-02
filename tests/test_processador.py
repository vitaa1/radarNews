from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from local.processador import (
    ArticleTextExtractor,
    RadarError,
    RejectRedirectHandler,
    build_messages,
    is_allowed_source_url,
    load_channel_profile,
    load_dotenv,
    normalize_editorial_history,
    normalize_text,
    process_once,
    release_item,
    validate_analysis,
    validate_configuration,
)


class ProcessadorTests(unittest.TestCase):
    def test_carrega_dotenv_utf8_com_bom(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "\ufeff# comentario\nRADAR_NEWS_TEST_VALUE=funcionou\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {}, clear=True):
                load_dotenv(env_path)
                self.assertEqual(os.environ["RADAR_NEWS_TEST_VALUE"], "funcionou")

    def test_permite_apenas_https_supercell_sem_credenciais_na_url(self) -> None:
        self.assertTrue(
            is_allowed_source_url(
                "https://supercell.com/en/games/brawlstars/blog/news/teste/"
            )
        )
        self.assertFalse(is_allowed_source_url("http://supercell.com/en/news/teste/"))
        self.assertFalse(is_allowed_source_url("https://evil.example/en/news/teste/"))
        self.assertFalse(is_allowed_source_url("https://supercell.com.evil.example/x"))
        self.assertFalse(is_allowed_source_url("https://usuario@supercell.com/x"))

    def test_extrator_prioriza_article_e_remove_script_nav_footer(self) -> None:
        parser = ArticleTextExtractor()
        parser.feed(
            """
            <nav>menu secreto</nav>
            <main><article><h1>Título oficial</h1>
            <p>Este é um conteúdo público suficientemente longo para ser usado.</p>
            <p>"""
            + "Detalhe oficial. " * 20
            + """</p><script>alert('não')</script></article></main>
            <footer>rodapé</footer>
            """
        )
        text = parser.text()
        self.assertIn("Título oficial", text)
        self.assertNotIn("menu secreto", text)
        self.assertNotIn("alert", text)
        self.assertNotIn("rodapé", text)

    def test_normaliza_espacos_sem_perder_paragrafos(self) -> None:
        self.assertEqual(normalize_text(" A   B \n\n\n C "), "A B\n\nC")

    def test_valida_analise_estruturada(self) -> None:
        value = {
            "resumo": "Resumo factual com tamanho suficiente para passar pela validação local.",
            "classificacao": "Comunicado",
            "prioridade": "Média",
            "publico_alvo": "Jogadores interessados nas novidades oficiais do jogo.",
            "angulo_diferenciado": "Explicar o impacto prático sem apenas repetir o anúncio oficial.",
            "gancho_abertura": "A novidade oficial traz uma mudança que merece atenção imediata.",
            "titulos": ["Título número um", "Título número dois", "Título número três"],
            "conceito_thumbnail": "Elemento oficial em destaque com o texto NOVA MUDANÇA.",
            "estrategia_retencao": "Abrir com a mudança, explicar o impacto e fechar com o que verificar.",
            "experimento_crescimento": "Testar apenas o gancho e comparar a retenção em 30 segundos.",
            "roteiro_curto": "Este é um roteiro factual para narração. " * 10,
            "pontos_a_verificar": "Nada além de conferir a fonte oficial",
        }
        self.assertEqual(validate_analysis(value)["prioridade"], "Média")

    def test_prompt_exige_diferenciacao_sem_inventar_fatos(self) -> None:
        messages = build_messages(
            {
                "source": "Supercell",
                "title": "Anúncio oficial",
                "url": "https://supercell.com/en/news/anuncio/",
            },
            "Texto oficial suficientemente longo para a análise.",
        )
        prompt = "\n".join(message["content"] for message in messages)
        self.assertIn("ângulo diferenciado", prompt)
        self.assertIn("primeiros 10 a 20 segundos", prompt)
        self.assertIn("pesquisável, intrigante e equilibrado", prompt)
        self.assertIn("Não acrescente rumores", prompt)

    def test_prompt_usa_perfil_e_historico_apenas_como_contexto(self) -> None:
        messages = build_messages(
            {
                "source": "Supercell",
                "title": "Anúncio",
                "url": "https://supercell.com/",
            },
            "Texto oficial.",
            {"tom_de_voz": "Direto e curioso"},
            [
                {
                    "title": "Vídeo anterior",
                    "classification": "Evento",
                    "angle": "Explicar primeiro o efeito para jogadores casuais.",
                }
            ],
            "Amostra registrada: 3 vídeos. Não presuma causalidade.",
        )
        prompt = "\n".join(message["content"] for message in messages)
        self.assertIn("PERFIL DO CANAL", prompt)
        self.assertIn("ÂNGULOS RECENTES", prompt)
        self.assertIn("RESULTADOS ANTERIORES", prompt)
        self.assertIn("nunca os apresente como fatos", prompt)

    def test_carrega_perfil_editorial_e_limita_campos(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "perfil-canal.json"
            path.write_text(
                '{"nome_canal":"Radar","tom_de_voz":"Direto",'
                '"diferenciais":["Contexto prático"]}',
                encoding="utf-8",
            )
            profile = load_channel_profile(path)
        self.assertEqual(profile["nome_canal"], "Radar")
        self.assertEqual(profile["diferenciais"], ["Contexto prático"])

    def test_rejeita_perfil_editorial_com_lista_vazia(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "perfil-canal.json"
            path.write_text('{"diferenciais":[]}', encoding="utf-8")
            with self.assertRaisesRegex(RadarError, "de 1 a 5 itens"):
                load_channel_profile(path)

    def test_normaliza_historico_editorial_sem_confiar_no_formato(self) -> None:
        history = normalize_editorial_history(
            [
                {
                    "title": "Anterior",
                    "classification": "Evento",
                    "angle": "Ângulo útil",
                },
                {"title": "Sem ângulo"},
                "inválido",
            ]
        )
        self.assertEqual(
            history,
            [
                {
                    "titulo": "Anterior",
                    "classificacao": "Evento",
                    "angulo": "Ângulo útil",
                }
            ],
        )

    def test_rejeita_classificacao_inventada(self) -> None:
        with self.assertRaises(RadarError):
            validate_analysis(
                {
                    "resumo": "Resumo factual com tamanho suficiente para passar pela validação.",
                    "classificacao": "Vazamento",
                    "prioridade": "Alta",
                    "publico_alvo": "Jogadores interessados nas novidades oficiais.",
                    "angulo_diferenciado": "Explicar o impacto prático sem repetir o anúncio oficial.",
                    "gancho_abertura": "Esta mudança oficial merece atenção de todos os jogadores.",
                    "titulos": ["Título um", "Título dois", "Título três"],
                    "conceito_thumbnail": "Imagem oficial com o texto MUDANÇA IMPORTANTE.",
                    "estrategia_retencao": "Mostrar a mudança, explicar o contexto e resumir a consequência.",
                    "experimento_crescimento": "Testar apenas o título e acompanhar a taxa de cliques.",
                    "roteiro_curto": "Roteiro suficientemente longo. " * 5,
                    "pontos_a_verificar": "Nada",
                }
            )

    def test_rejeita_analise_sem_angulo_diferenciado(self) -> None:
        with self.assertRaisesRegex(RadarError, "campo de texto obrigatório"):
            validate_analysis(
                {
                    "resumo": "Resumo factual com tamanho suficiente para passar pela validação.",
                    "classificacao": "Comunicado",
                    "prioridade": "Média",
                    "publico_alvo": "Jogadores interessados nas novidades oficiais.",
                    "gancho_abertura": "Esta mudança oficial merece atenção de todos os jogadores.",
                    "titulos": ["Título um", "Título dois", "Título três"],
                    "conceito_thumbnail": "Imagem oficial com o texto MUDANÇA IMPORTANTE.",
                    "estrategia_retencao": "Mostrar a mudança, explicar o contexto e resumir a consequência.",
                    "experimento_crescimento": "Testar apenas o título e acompanhar a taxa de cliques.",
                    "roteiro_curto": "Roteiro suficientemente longo. " * 5,
                    "pontos_a_verificar": "Nada além da fonte oficial",
                }
            )

    def test_rejeita_roteiro_curto_demais_para_a_duracao(self) -> None:
        with self.assertRaisesRegex(RadarError, "65 e 160 palavras"):
            validate_analysis(
                {
                    "resumo": "Resumo factual com tamanho suficiente para passar pela validação.",
                    "classificacao": "Comunicado",
                    "prioridade": "Média",
                    "publico_alvo": "Jogadores interessados nas novidades oficiais.",
                    "angulo_diferenciado": "Explicar o impacto prático sem repetir o anúncio oficial.",
                    "gancho_abertura": "Esta mudança oficial merece atenção de todos os jogadores.",
                    "titulos": ["Título um", "Título dois", "Título três"],
                    "conceito_thumbnail": "Imagem oficial com o texto MUDANÇA IMPORTANTE.",
                    "estrategia_retencao": "Mostrar a mudança, explicar o contexto e resumir a consequência.",
                    "experimento_crescimento": "Testar apenas o título e acompanhar a taxa de cliques.",
                    "roteiro_curto": "Este roteiro ainda está curto. " * 10,
                    "pontos_a_verificar": "Nada além da fonte oficial",
                }
            )

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

    def test_rejeita_worker_url_com_credenciais_caminho_ou_query(self) -> None:
        invalid_urls = (
            "https://usuario@radar.example",
            "https://radar.example/caminho",
            "https://radar.example?destino=outro",
        )
        for worker_url in invalid_urls:
            with self.subTest(worker_url=worker_url), self.assertRaises(RadarError):
                validate_configuration(
                    worker_url,
                    "s" * 32,
                    "http://127.0.0.1:11434",
                    "gemma3:4b",
                )

    def test_rejeita_worker_em_porta_https_nao_padrao(self) -> None:
        with self.assertRaisesRegex(RadarError, "porta HTTPS"):
            validate_configuration(
                "https://radar.example:4443",
                "s" * 32,
                "http://127.0.0.1:11434",
                "gemma3:4b",
            )

    def test_release_confirma_resultado_e_pode_nao_contar_dry_run(self) -> None:
        with patch(
            "local.processador.request_json",
            return_value={"ok": True, "released": True, "retryCount": 2},
        ) as request:
            result = release_item(
                "https://radar.example",
                "s" * 32,
                "a" * 64,
                "claim",
                "Teste --dry-run",
                count_failure=False,
            )
        self.assertEqual(result["retryCount"], 2)
        self.assertFalse(request.call_args.kwargs["payload"]["countFailure"])

    def test_release_rejeita_resposta_sem_confirmacao(self) -> None:
        with (
            patch(
                "local.processador.request_json",
                return_value={"ok": True, "released": False},
            ),
            self.assertRaisesRegex(RadarError, "não confirmou"),
        ):
            release_item(
                "https://radar.example",
                "s" * 32,
                "a" * 64,
                "claim",
                "Falha",
            )

    def test_lote_reserva_um_item_por_vez(self) -> None:
        claim_results = iter(
            [
                {
                    "claimToken": "token-1",
                    "items": [
                        {
                            "id": "a" * 64,
                            "source": "Supercell",
                            "title": "Item A",
                            "url": "https://supercell.com/en/news/item-a/",
                        }
                    ],
                },
                {
                    "claimToken": "token-2",
                    "items": [
                        {
                            "id": "b" * 64,
                            "source": "Supercell",
                            "title": "Item B",
                            "url": "https://supercell.com/en/news/item-b/",
                        }
                    ],
                },
            ]
        )
        calls: list[tuple[str, dict[str, object]]] = []
        analysis = {
            "resumo": "Resumo factual com tamanho suficiente para passar pela validação local.",
            "classificacao": "Comunicado",
            "prioridade": "Média",
            "publico_alvo": "Jogadores interessados nas novidades oficiais do jogo.",
            "angulo_diferenciado": "Explicar o impacto prático sem apenas repetir o anúncio oficial.",
            "gancho_abertura": "A novidade oficial traz uma mudança que merece atenção imediata.",
            "titulos": ["Título número um", "Título número dois", "Título número três"],
            "conceito_thumbnail": "Elemento oficial em destaque com o texto NOVA MUDANÇA.",
            "estrategia_retencao": "Abrir com a mudança, explicar o impacto e fechar com o que verificar.",
            "experimento_crescimento": "Testar apenas o gancho e comparar a retenção em 30 segundos.",
            "roteiro_curto": "Este é um roteiro factual para narração. " * 10,
            "pontos_a_verificar": "Conferir a fonte oficial",
        }

        def fake_request(url: str, **kwargs: object) -> dict[str, object]:
            calls.append((url, kwargs))
            if "/claim?" in url:
                return next(claim_results)
            return {"ok": True, "delivered": True}

        with (
            patch("local.processador.request_json", side_effect=fake_request),
            patch(
                "local.processador.download_article",
                return_value="Texto oficial. " * 30,
            ),
            patch("local.processador.call_ollama", return_value=analysis),
        ):
            processed, failed = process_once(
                "https://radar.example",
                "s" * 32,
                "http://127.0.0.1:11434",
                "gemma3:4b",
                batch_size=2,
                dry_run=False,
            )

        self.assertEqual((processed, failed), (2, 0))
        claim_calls = [call for call in calls if "/claim?" in call[0]]
        self.assertEqual(len(claim_calls), 2)
        self.assertTrue(all(call[0].endswith("limit=1") for call in claim_calls))
        complete_calls = [call for call in calls if call[0].endswith("/complete")]
        self.assertEqual(
            [call[1]["payload"]["claimToken"] for call in complete_calls],
            ["token-1", "token-2"],
        )


if __name__ == "__main__":
    unittest.main()

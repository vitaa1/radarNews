from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

if __package__:
    from .configuration import (
        load_channel_profile,
        load_dotenv,
        positive_int_env,
        validate_configuration,
    )
    from .desempenho import build_performance_context
    from .editorial import (
        build_messages,
        call_ollama,
        normalize_editorial_history,
        validate_analysis,
    )
    from .errors import RadarError
    from .http_client import RejectRedirectHandler, request_json
    from .source_reader import (
        ArticleTextExtractor,
        download_article,
        is_allowed_source_url,
        normalize_text,
    )
else:
    from configuration import (
        load_channel_profile,
        load_dotenv,
        positive_int_env,
        validate_configuration,
    )
    from desempenho import build_performance_context
    from editorial import (
        build_messages,
        call_ollama,
        normalize_editorial_history,
        validate_analysis,
    )
    from errors import RadarError
    from http_client import RejectRedirectHandler, request_json
    from source_reader import (
        ArticleTextExtractor,
        download_article,
        is_allowed_source_url,
        normalize_text,
    )


BASE_DIR = Path(__file__).resolve().parent

# Preserva a API existente para quem já importa funções de local.processador.
__all__ = [
    "ArticleTextExtractor",
    "RadarError",
    "RejectRedirectHandler",
    "build_messages",
    "is_allowed_source_url",
    "load_channel_profile",
    "load_dotenv",
    "main",
    "normalize_editorial_history",
    "normalize_text",
    "process_once",
    "release_item",
    "validate_analysis",
    "validate_configuration",
]


def release_item(
    worker_url: str,
    secret: str,
    item_id: str,
    claim_token: str,
    error: str,
    *,
    count_failure: bool = True,
) -> dict[str, Any]:
    result = request_json(
        f"{worker_url.rstrip('/')}/api/items/{item_id}/release",
        method="POST",
        token=secret,
        payload={
            "claimToken": claim_token,
            "error": error[:500],
            "countFailure": count_failure,
        },
    )
    if result.get("released") is not True:
        raise RadarError("O Worker não confirmou a devolução do item à fila.")
    return result


def process_once(
    worker_url: str,
    secret: str,
    ollama_url: str,
    model: str,
    batch_size: int,
    dry_run: bool,
    channel_profile: dict[str, Any] | None = None,
    performance_context: str = "",
) -> tuple[int, int]:
    processed = 0
    failed = 0
    for _ in range(batch_size):
        result = request_json(
            f"{worker_url.rstrip('/')}/api/items/claim?limit=1",
            method="POST",
            token=secret,
        )
        claim_token = result.get("claimToken")
        items = result.get("items")
        editorial_history = normalize_editorial_history(result.get("editorialHistory"))
        if not isinstance(claim_token, str) or not isinstance(items, list):
            raise RadarError("O Worker devolveu uma reserva em formato inesperado.")
        if len(items) > 1:
            raise RadarError(
                "O Worker devolveu mais de um item para uma reserva individual."
            )
        if not items:
            if processed == 0 and failed == 0:
                print("Nenhuma pauta pendente.")
            break

        item = items[0]
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            failed += 1
            print("Item inválido recebido do Worker.", file=sys.stderr)
            break
        item_id = item["id"]
        print(f"Processando: {item.get('title', 'sem título')}")
        try:
            url = item.get("url")
            if not isinstance(url, str):
                raise RadarError("O item não contém uma URL válida.")
            article = download_article(url)
            analysis = call_ollama(
                ollama_url,
                model,
                build_messages(
                    item,
                    article,
                    channel_profile,
                    editorial_history,
                    performance_context,
                ),
            )
            if dry_run:
                print(json.dumps(analysis, ensure_ascii=False, indent=2))
                release_item(
                    worker_url,
                    secret,
                    item_id,
                    claim_token,
                    "Teste --dry-run",
                    count_failure=False,
                )
                print("Teste concluído; item devolvido à fila.")
            else:
                delivery = request_json(
                    f"{worker_url.rstrip('/')}/api/items/{item_id}/complete",
                    method="POST",
                    token=secret,
                    payload={"claimToken": claim_token, "analysis": analysis},
                )
                delivered = delivery.get("delivered")
                delivery_pending = delivery.get("deliveryPending")
                if (
                    delivery.get("ok") is True
                    and delivery_pending is True
                    and (delivered is None or delivered is False)
                ):
                    print("Pauta salva; o Telegram será tentado novamente pelo Worker.")
                elif (
                    delivery.get("ok") is True
                    and delivered is True
                    and (delivery_pending is None or delivery_pending is False)
                ):
                    print("Pauta enviada ao Telegram.")
                else:
                    raise RadarError(
                        "O Worker não confirmou a conclusão nem o reagendamento da pauta."
                    )
            processed += 1
        # Qualquer falha devolve o item à fila para uma nova tentativa.
        except Exception as error:
            failed += 1
            message = str(error)
            print(
                f"Falha ao processar {item.get('title', 'item')}: {message}",
                file=sys.stderr,
            )
            try:
                release = release_item(
                    worker_url, secret, item_id, claim_token, message
                )
                if release.get("deadLettered"):
                    print(
                        "O item atingiu o limite de tentativas e foi movido para a fila de falhas.",
                        file=sys.stderr,
                    )
            except Exception as release_error:
                print(
                    f"Também não foi possível devolver o item à fila: {release_error}",
                    file=sys.stderr,
                )
            break
    return (processed, failed)


def main() -> int:
    try:
        load_dotenv(BASE_DIR / ".env")
        channel_profile = load_channel_profile(BASE_DIR / "perfil-canal.json")
        parser = argparse.ArgumentParser(description="Processador local do radarNews")
        parser.add_argument(
            "--once", action="store_true", help="Executa uma vez e encerra"
        )
        parser.add_argument(
            "--dry-run", action="store_true", help="Mostra a pauta e a devolve à fila"
        )
        args = parser.parse_args()

        worker_url = os.getenv("WORKER_URL", "").strip().rstrip("/")
        secret = os.getenv("SHARED_SECRET", "").strip()
        ollama_url = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").strip()
        model = os.getenv("OLLAMA_MODEL", "gemma3:4b").strip()
        interval = positive_int_env("LOCAL_POLL_SECONDS", 60, 30, 3_600)
        batch_size = positive_int_env("LOCAL_BATCH_SIZE", 3, 1, 5)
        validate_configuration(worker_url, secret, ollama_url, model)
    except RadarError as error:
        print(f"Configuração inválida: {error}", file=sys.stderr)
        return 2

    try:
        while True:
            try:
                try:
                    performance_context = build_performance_context(
                        BASE_DIR / "desempenho.db"
                    )
                except (OSError, sqlite3.Error, ValueError) as error:
                    performance_context = ""
                    print(
                        f"Aviso: o histórico de desempenho não pôde ser lido: {error}",
                        file=sys.stderr,
                    )
                _, failed = process_once(
                    worker_url,
                    secret,
                    ollama_url,
                    model,
                    batch_size,
                    args.dry_run,
                    channel_profile,
                    performance_context,
                )
                if args.once:
                    return 1 if failed else 0
            except RadarError as error:
                print(f"Falha do ciclo: {error}", file=sys.stderr)
                if args.once:
                    return 1
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nProcessador encerrado pelo usuário.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

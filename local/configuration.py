from __future__ import annotations

import json
import os
import re
import urllib.parse
from pathlib import Path
from typing import Any

if __package__:
    from .errors import RadarError
else:
    from errors import RadarError


def load_dotenv(path: Path) -> None:
    """Carrega um .env simples sem substituir variáveis já definidas no sistema."""
    if not path.exists():
        return
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8-sig").splitlines(), start=1
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise RadarError(f"Linha {line_number} inválida em {path.name}: falta '='.")
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise RadarError(f"Nome de variável inválido na linha {line_number}.")
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def load_channel_profile(path: Path) -> dict[str, Any] | None:
    """Carrega preferências editoriais opcionais em um formato previsível."""
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise RadarError(f"O perfil editorial em {path.name} não é um JSON válido.") from error
    if not isinstance(value, dict):
        raise RadarError(f"O perfil editorial em {path.name} deve ser um objeto JSON.")

    string_limits = {
        "nome_canal": 100,
        "posicionamento": 500,
        "publico_principal": 500,
        "tom_de_voz": 300,
    }
    list_limits = {"diferenciais": 5, "evitar": 8}
    profile: dict[str, Any] = {}
    for key, maximum in string_limits.items():
        raw = value.get(key)
        if raw is None:
            continue
        if not isinstance(raw, str) or not raw.strip():
            raise RadarError(f"O campo {key} do perfil editorial deve ser um texto.")
        profile[key] = raw.strip()[:maximum]
    for key, maximum_items in list_limits.items():
        raw = value.get(key)
        if raw is None:
            continue
        if not isinstance(raw, list) or not 1 <= len(raw) <= maximum_items:
            raise RadarError(
                f"O campo {key} do perfil editorial deve ter de 1 a {maximum_items} itens."
            )
        if not all(isinstance(item, str) and item.strip() for item in raw):
            raise RadarError(f"O campo {key} do perfil editorial contém um item inválido.")
        profile[key] = [item.strip()[:200] for item in raw]
    if not profile:
        raise RadarError(f"O perfil editorial em {path.name} está vazio.")
    return profile


def positive_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as error:
        raise RadarError(f"{name} deve ser um número inteiro.") from error
    return min(max(value, minimum), maximum)


def validate_configuration(
    worker_url: str, secret: str, ollama_url: str, model: str
) -> None:
    parsed_worker = urllib.parse.urlsplit(worker_url)
    parsed_ollama = urllib.parse.urlsplit(ollama_url)
    if (
        parsed_worker.scheme != "https"
        or not parsed_worker.hostname
        or parsed_worker.username is not None
        or parsed_worker.password is not None
        or parsed_worker.query
        or parsed_worker.fragment
        or parsed_worker.path not in {"", "/"}
    ):
        raise RadarError("WORKER_URL deve ser uma URL HTTPS completa.")
    if len(secret) < 24:
        raise RadarError("SHARED_SECRET deve ter pelo menos 24 caracteres.")
    try:
        worker_port = parsed_worker.port
        ollama_port = parsed_ollama.port
    except ValueError as error:
        raise RadarError("WORKER_URL ou OLLAMA_URL contém uma porta inválida.") from error
    if worker_port not in (None, 443):
        raise RadarError("WORKER_URL deve usar a porta HTTPS padrão 443.")
    if (
        parsed_ollama.scheme not in {"http", "https"}
        or not parsed_ollama.netloc
        or parsed_ollama.username is not None
        or parsed_ollama.password is not None
        or parsed_ollama.query
        or parsed_ollama.fragment
        or ollama_port is not None
        and not 1 <= ollama_port <= 65535
    ):
        raise RadarError("OLLAMA_URL deve ser uma URL HTTP ou HTTPS completa.")
    if not model:
        raise RadarError("OLLAMA_MODEL não pode ficar vazio.")

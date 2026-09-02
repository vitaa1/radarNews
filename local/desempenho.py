from __future__ import annotations

import argparse
import re
import sqlite3
from contextlib import closing
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = BASE_DIR / "desempenho.db"
FORMATS = ("Short", "Vídeo")
TITLE_STYLES = ("Pesquisável", "Intrigante", "Equilibrado", "Outro")
YOUTUBE_HOSTS = frozenset(
    {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
)


def connect_database(path: Path = DEFAULT_DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS video_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          youtube_url TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          format TEXT NOT NULL CHECK (format IN ('Short', 'Vídeo')),
          title_style TEXT NOT NULL
            CHECK (title_style IN ('Pesquisável', 'Intrigante', 'Equilibrado', 'Outro')),
          published_on TEXT NOT NULL,
          views_48h INTEGER CHECK (views_48h IS NULL OR views_48h >= 0),
          views_7d INTEGER CHECK (views_7d IS NULL OR views_7d >= 0),
          ctr_percent REAL CHECK (ctr_percent IS NULL OR ctr_percent BETWEEN 0 AND 100),
          retention_30s_percent REAL
            CHECK (retention_30s_percent IS NULL OR retention_30s_percent BETWEEN 0 AND 100),
          average_percentage_viewed REAL
            CHECK (average_percentage_viewed IS NULL OR average_percentage_viewed BETWEEN 0 AND 1000),
          subscribers_gained INTEGER
            CHECK (subscribers_gained IS NULL OR subscribers_gained >= 0),
          notes TEXT,
          recorded_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_video_results_published ON video_results(published_on DESC)"
    )
    connection.commit()
    return connection


def normalize_youtube_url(value: str) -> str:
    value = value.strip()
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in YOUTUBE_HOSTS
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("Informe uma URL pública HTTPS válida do YouTube.")
    video_id = ""
    if parsed.hostname == "youtu.be":
        video_id = parsed.path.strip("/").split("/", 1)[0]
    elif parsed.path.rstrip("/") == "/watch":
        video_id = parse_qs(parsed.query).get("v", [""])[0]
    else:
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 2 and parts[0] in {"shorts", "live"}:
            video_id = parts[1]
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError(
            "A URL não contém um identificador válido de vídeo do YouTube."
        )
    return f"https://www.youtube.com/watch?v={video_id}"


def optional_int(value: Any, field: str) -> int | None:
    if value is None or value == "":
        return None
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} deve ser um número inteiro.") from error
    if result < 0:
        raise ValueError(f"{field} não pode ser negativo.")
    return result


def optional_percent(value: Any, field: str, maximum: float = 100) -> float | None:
    if value is None or value == "":
        return None
    try:
        result = float(str(value).replace(",", "."))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} deve ser um número.") from error
    if not 0 <= result <= maximum:
        raise ValueError(f"{field} deve ficar entre 0 e {maximum:g}.")
    return round(result, 2)


def clean_text(value: Any, maximum: int) -> str:
    return re.sub(r"[\x00-\x1f\x7f]+", " ", str(value)).strip()[:maximum]


def validate_result(value: dict[str, Any]) -> dict[str, Any]:
    title = clean_text(value.get("title", ""), 200)
    if not title:
        raise ValueError("O título do vídeo é obrigatório.")
    content_format = str(value.get("format", "")).strip()
    if content_format not in FORMATS:
        raise ValueError(f"O formato deve ser {' ou '.join(FORMATS)}.")
    title_style = str(value.get("title_style", "")).strip()
    if title_style not in TITLE_STYLES:
        raise ValueError(
            f"O estilo do título deve ser um de: {', '.join(TITLE_STYLES)}."
        )
    published_on = str(value.get("published_on", "")).strip()
    try:
        publication_date = date.fromisoformat(published_on)
    except ValueError as error:
        raise ValueError("A data de publicação deve usar AAAA-MM-DD.") from error
    if publication_date > date.today():
        raise ValueError("A data de publicação não pode estar no futuro.")

    notes = clean_text(value.get("notes", ""), 500)
    return {
        "youtube_url": normalize_youtube_url(str(value.get("youtube_url", ""))),
        "title": title,
        "format": content_format,
        "title_style": title_style,
        "published_on": published_on,
        "views_48h": optional_int(value.get("views_48h"), "Views em 48h"),
        "views_7d": optional_int(value.get("views_7d"), "Views em 7 dias"),
        "ctr_percent": optional_percent(value.get("ctr_percent"), "CTR"),
        "retention_30s_percent": optional_percent(
            value.get("retention_30s_percent"), "Retenção em 30 segundos"
        ),
        "average_percentage_viewed": optional_percent(
            value.get("average_percentage_viewed"),
            "Percentual médio assistido",
            1_000,
        ),
        "subscribers_gained": optional_int(
            value.get("subscribers_gained"), "Inscritos ganhos"
        ),
        "notes": notes or None,
    }


def save_result(value: dict[str, Any], path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    result = validate_result(value)
    now = datetime.now(UTC).isoformat()
    with closing(connect_database(path)) as connection:
        with connection:
            connection.execute(
                """
            INSERT INTO video_results (
              youtube_url, title, format, title_style, published_on,
              views_48h, views_7d, ctr_percent, retention_30s_percent,
              average_percentage_viewed, subscribers_gained, notes,
              recorded_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(youtube_url) DO UPDATE SET
              title = excluded.title,
              format = excluded.format,
              title_style = excluded.title_style,
              published_on = excluded.published_on,
              views_48h = COALESCE(excluded.views_48h, video_results.views_48h),
              views_7d = COALESCE(excluded.views_7d, video_results.views_7d),
              ctr_percent = COALESCE(excluded.ctr_percent, video_results.ctr_percent),
              retention_30s_percent = COALESCE(
                excluded.retention_30s_percent, video_results.retention_30s_percent
              ),
              average_percentage_viewed = COALESCE(
                excluded.average_percentage_viewed, video_results.average_percentage_viewed
              ),
              subscribers_gained = COALESCE(
                excluded.subscribers_gained, video_results.subscribers_gained
              ),
              notes = COALESCE(excluded.notes, video_results.notes),
              updated_at = excluded.updated_at
                """,
                (
                    result["youtube_url"],
                    result["title"],
                    result["format"],
                    result["title_style"],
                    result["published_on"],
                    result["views_48h"],
                    result["views_7d"],
                    result["ctr_percent"],
                    result["retention_30s_percent"],
                    result["average_percentage_viewed"],
                    result["subscribers_gained"],
                    result["notes"],
                    now,
                    now,
                ),
            )
    return result


def get_result(youtube_url: str, path: Path = DEFAULT_DB_PATH) -> dict[str, Any] | None:
    if not path.exists():
        return None
    normalized = normalize_youtube_url(youtube_url)
    with closing(connect_database(path)) as connection:
        row = connection.execute(
            "SELECT * FROM video_results WHERE youtube_url = ?", (normalized,)
        ).fetchone()
    return dict(row) if row else None


def metric_average(rows: list[sqlite3.Row], field: str) -> tuple[float, int] | None:
    values = [float(row[field]) for row in rows if row[field] is not None]
    if not values:
        return None
    return (sum(values) / len(values), len(values))


def build_performance_context(path: Path = DEFAULT_DB_PATH, limit: int = 8) -> str:
    if not path.exists():
        return ""
    safe_limit = min(max(int(limit), 1), 20)
    with closing(connect_database(path)) as connection:
        total = int(
            connection.execute("SELECT COUNT(*) FROM video_results").fetchone()[0]
        )
        rows = connection.execute(
            "SELECT * FROM video_results ORDER BY published_on DESC, id DESC LIMIT ?",
            (safe_limit,),
        ).fetchall()
    if not rows:
        return ""

    lines = [
        f"Amostra registrada: {total} vídeo(s).",
        "Não presuma causalidade. Com menos de 5 vídeos comparáveis, trate padrões como hipóteses.",
    ]
    for content_format in FORMATS:
        comparable = [row for row in rows if row["format"] == content_format]
        averages = []
        for field, label in (
            ("ctr_percent", "CTR"),
            ("retention_30s_percent", "retenção em 30s"),
            ("average_percentage_viewed", "percentual médio assistido"),
        ):
            result = metric_average(comparable, field)
            if result:
                average, count = result
                averages.append(f"{label} {average:.1f}% (n={count})")
        if averages:
            lines.append(
                f"Médias recentes de {content_format}: " + "; ".join(averages) + "."
            )

    lines.append("Vídeos recentes:")
    for row in rows:
        metrics = []
        for field, label, suffix in (
            ("views_48h", "48h", " views"),
            ("views_7d", "7d", " views"),
            ("ctr_percent", "CTR", "%"),
            ("retention_30s_percent", "retenção 30s", "%"),
            ("average_percentage_viewed", "média assistida", "%"),
            ("subscribers_gained", "inscritos", ""),
        ):
            if row[field] is not None:
                metrics.append(f"{label}={row[field]}{suffix}")
        details = ", ".join(metrics) if metrics else "métricas ainda não preenchidas"
        note = f"; nota={str(row['notes'])[:180]}" if row["notes"] else ""
        lines.append(
            f"- {str(row['title'])[:160]} | {row['format']} | título {row['title_style']} | "
            f"{details}{note}"
        )
    return "\n".join(lines)[:4_000]


def prompt_value(label: str, current: Any = None, required: bool = False) -> str:
    suffix = f" [{current}]" if current not in (None, "") else ""
    while True:
        value = input(f"{label}{suffix}: ").strip()
        if value:
            return value
        if current not in (None, ""):
            return str(current)
        if not required:
            return ""
        print("Este campo é obrigatório.")


def interactive_result(path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    print("Registro local de desempenho do YouTube")
    print("Deixe uma métrica vazia se ela ainda não estiver disponível.")
    youtube_url = prompt_value("URL pública do vídeo", required=True)
    current = get_result(youtube_url, path) or {}
    result = {
        "youtube_url": youtube_url,
        "title": prompt_value("Título publicado", current.get("title"), True),
        "format": prompt_value(
            "Formato (Short/Vídeo)", current.get("format") or "Short", True
        ),
        "title_style": prompt_value(
            "Estilo do título (Pesquisável/Intrigante/Equilibrado/Outro)",
            current.get("title_style") or "Equilibrado",
            True,
        ),
        "published_on": prompt_value(
            "Data de publicação (AAAA-MM-DD)",
            current.get("published_on") or date.today(),
            True,
        ),
        "views_48h": prompt_value("Views após 48h", current.get("views_48h")),
        "views_7d": prompt_value("Views após 7 dias", current.get("views_7d")),
        "ctr_percent": prompt_value("CTR em %", current.get("ctr_percent")),
        "retention_30s_percent": prompt_value(
            "Retenção aos 30 segundos em %", current.get("retention_30s_percent")
        ),
        "average_percentage_viewed": prompt_value(
            "Percentual médio assistido", current.get("average_percentage_viewed")
        ),
        "subscribers_gained": prompt_value(
            "Inscritos ganhos", current.get("subscribers_gained")
        ),
        "notes": prompt_value("Observação editorial", current.get("notes")),
    }
    return save_result(result, path)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Diário local de desempenho dos vídeos usados pelo radarNews"
    )
    parser.add_argument(
        "command", choices=("registrar", "resumo"), help="ação a executar"
    )
    args = parser.parse_args()
    try:
        if args.command == "registrar":
            saved = interactive_result()
            print(f"Resultado salvo localmente: {saved['title']}")
        else:
            context = build_performance_context()
            print(context or "Nenhum resultado registrado ainda.")
        return 0
    except (ValueError, OSError, sqlite3.Error) as error:
        print(f"Não foi possível registrar o desempenho: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Executa a CLI real com transporte HTTP restrito ao servidor local de fixtures.

Mantém as URLs HTTPS originais para exercitar validadores e redirecionamentos.
Somente o transporte TLS é substituído; não altera funções do processador.
"""

from __future__ import annotations

import http.client
import runpy
import sys
import urllib.request
from pathlib import Path


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    script = Path(sys.argv[1]).resolve()
    port = int(sys.argv[2])

    class LocalConnection(http.client.HTTPConnection):
        def __init__(self, host: str, **kwargs: object) -> None:
            if host not in {"worker.test", "ollama.test", "supercell.com"}:
                raise RuntimeError("Destino fora das fixtures recusado")
            super().__init__("127.0.0.1", port, **kwargs)

    class FixtureHTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req: urllib.request.Request):
            return self.do_open(LocalConnection, req)

    class DenyHTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req: urllib.request.Request):
            raise RuntimeError("HTTP externo recusado nos testes")

    # O build_opener do código real continua incluindo seus handlers de segurança.
    urllib.request.HTTPSHandler = FixtureHTTPSHandler
    urllib.request.HTTPHandler = DenyHTTPHandler
    sys.path.insert(0, str(script.parent))
    sys.argv = [str(script), "--once", *sys.argv[3:]]
    runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    main()

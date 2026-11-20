"""Petit client HTTP basé sur urllib (aucune dépendance)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Tuple

# transport(method, url, headers, body, timeout) -> (status, texte)
Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float], Tuple[int, str]]


def urllib_transport(
    method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float
) -> Tuple[int, str]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", errors="replace")


def parse_json(texte: str) -> Any:
    if not texte:
        return None
    try:
        return json.loads(texte)
    except ValueError:
        return texte

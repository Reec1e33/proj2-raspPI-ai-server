"""Early pytest plugin: make ``import httpx`` resolve to ``httpx2``.

The anthropic and openai SDKs (and this app) use httpx2. respx patches whatever
``httpx``/``httpcore`` resolve to, so the alias must be installed before respx's own
pytest plugin imports it. ``-p tests._alias_httpx`` in addopts guarantees that order.
"""

import httpx2

httpx2.alias_httpx()

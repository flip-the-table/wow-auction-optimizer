"""
Blizzard Game Data API client with OAuth, rate limiting, retries, and ETag caching.

Official API documentation:
  https://develop.battle.net/documentation/world-of-warcraft/game-data-apis

Verified endpoints:
  OAuth token:           POST https://oauth.battle.net/token
  Connected Realm Index: GET  /data/wow/connected-realm/index         (dynamic-{region})
  Connected Realm:       GET  /data/wow/connected-realm/{id}          (dynamic-{region})
  Auctions:              GET  /data/wow/connected-realm/{id}/auctions (dynamic-{region})
  Commodities:           GET  /data/wow/auctions/commodities          (dynamic-{region})
  Item:                  GET  /data/wow/item/{id}                     (static-{region})
  Item Media:            GET  /data/wow/media/item/{id}               (static-{region})

  All endpoints require Authorization: Bearer <token> header.
  Namespaces are passed via ?namespace=<namespace> query param.
"""

import asyncio
import hashlib
import json
import logging
import random
import time
from typing import Any

import httpx

from packages.shared.config import Settings, get_settings

logger = logging.getLogger(__name__)

# Sentinel for "not modified" (304) responses
NOT_MODIFIED = object()


class TokenManager:
    """Manages OAuth2 client_credentials token lifecycle."""

    def __init__(self, client_id: str, client_secret: str):
        self._client_id = client_id
        self._client_secret = client_secret
        self._token: str | None = None
        self._expires_at: float = 0
        self._lock = asyncio.Lock()

    async def get_token(self, http_client: httpx.AsyncClient) -> str:
        """Get a valid access token, refreshing if expired."""
        if self._token and time.time() < self._expires_at - 60:
            return self._token

        async with self._lock:
            # Double-check after acquiring lock
            if self._token and time.time() < self._expires_at - 60:
                return self._token

            logger.info("Requesting new Blizzard OAuth token")
            # https://develop.battle.net/documentation/guides/using-oauth
            resp = await http_client.post(
                "https://oauth.battle.net/token",
                data={"grant_type": "client_credentials"},
                auth=(self._client_id, self._client_secret),
            )
            resp.raise_for_status()
            data = resp.json()
            self._token = data["access_token"]
            self._expires_at = time.time() + data.get("expires_in", 86400)
            logger.info(
                "OAuth token acquired, expires in %ds",
                data.get("expires_in", 86400),
            )
            return self._token


class RateLimiter:
    """Token bucket rate limiter for Blizzard API calls."""

    def __init__(self, rate_per_second: int = 80):
        self._rate = rate_per_second
        self._tokens = float(rate_per_second)
        self._max_tokens = float(rate_per_second)
        self._last_refill = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self):
        """Wait until a token is available."""
        while True:
            async with self._lock:
                now = time.monotonic()
                elapsed = now - self._last_refill
                self._tokens = min(
                    self._max_tokens,
                    self._tokens + elapsed * self._rate,
                )
                self._last_refill = now

                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return

            # No token available -- wait a bit
            await asyncio.sleep(1.0 / self._rate)


class BlizzardClient:
    """
    High-level Blizzard API client with:
    - OAuth token injection
    - Rate limiting (token bucket)
    - Exponential backoff + jitter on 429/5xx
    - ETag caching via Redis (when available) or in-memory dict
    - Structured logging of latency, status codes, retry counts
    """

    MAX_RETRIES = 5
    BASE_BACKOFF = 1.0  # seconds

    def __init__(
        self,
        settings: Settings | None = None,
        redis=None,
    ):
        self._settings = settings or get_settings()
        self._redis = redis
        self._http: httpx.AsyncClient | None = None
        self._token_mgr = TokenManager(
            self._settings.blizzard_client_id,
            self._settings.blizzard_client_secret,
        )
        self._rate_limiter = RateLimiter(
            self._settings.blizzard_rate_limit_per_second
        )
        # In-memory ETag cache fallback when Redis is unavailable
        self._etag_cache: dict[str, tuple[str, Any]] = {}
        # Metrics
        self._request_count = 0
        self._retry_count = 0
        self._rate_limit_count = 0

    async def _get_http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0, connect=10.0),
                follow_redirects=True,
            )
        return self._http

    async def close(self):
        if self._http:
            await self._http.aclose()
            self._http = None

    def _api_base(self) -> str:
        return f"https://{self._settings.region}.api.blizzard.com"

    def _build_url(self, path: str) -> str:
        return f"{self._api_base()}{path}"

    def _cache_key(self, url: str, params: dict) -> str:
        """Stable cache key for ETag lookups."""
        raw = f"{url}|{json.dumps(params, sort_keys=True)}"
        return f"etag:{hashlib.md5(raw.encode()).hexdigest()}"

    async def _get_etag(self, cache_key: str) -> tuple[str | None, Any]:
        """Retrieve cached ETag and response body."""
        if self._redis:
            try:
                cached = await self._redis.get(cache_key)
                if cached:
                    data = json.loads(cached)
                    return data.get("etag"), data.get("body")
            except Exception:
                pass
        elif cache_key in self._etag_cache:
            etag, body = self._etag_cache[cache_key]
            return etag, body
        return None, None

    async def _set_etag(self, cache_key: str, etag: str, body: Any):
        """Store ETag and response body in cache."""
        if self._redis:
            try:
                await self._redis.set(
                    cache_key,
                    json.dumps({"etag": etag, "body": body}),
                    ex=7200,  # 2 hour TTL for dynamic data
                )
            except Exception:
                pass
        else:
            self._etag_cache[cache_key] = (etag, body)

    async def request(
        self,
        path: str,
        namespace: str | None = None,
        params: dict | None = None,
        use_etag: bool = True,
    ) -> Any:
        """
        Make an authenticated, rate-limited request to Blizzard API.

        Returns parsed JSON body, or NOT_MODIFIED sentinel if 304.
        Raises httpx.HTTPStatusError on non-retryable errors.
        """
        http = await self._get_http()
        url = self._build_url(path)
        query_params = dict(params or {})
        if namespace:
            query_params["namespace"] = namespace
        query_params["locale"] = self._settings.locale

        cache_key = self._cache_key(url, query_params)
        etag = None
        cached_body = None
        if use_etag:
            etag, cached_body = await self._get_etag(cache_key)

        for attempt in range(self.MAX_RETRIES + 1):
            await self._rate_limiter.acquire()
            token = await self._token_mgr.get_token(http)

            headers = {"Authorization": f"Bearer {token}"}
            if etag and use_etag:
                headers["If-Modified-Since"] = ""
                headers["If-None-Match"] = etag

            self._request_count += 1
            t0 = time.monotonic()

            try:
                resp = await http.get(url, params=query_params, headers=headers)
                latency_ms = (time.monotonic() - t0) * 1000

                if resp.status_code == 304:
                    logger.debug(
                        "Blizzard API 304 Not Modified: %s (%.0fms)",
                        path,
                        latency_ms,
                    )
                    return cached_body if cached_body is not None else NOT_MODIFIED

                if resp.status_code == 429:
                    self._rate_limit_count += 1
                    retry_after = float(resp.headers.get("Retry-After", "1"))
                    backoff = max(
                        retry_after,
                        self.BASE_BACKOFF * (2**attempt)
                        + random.uniform(0, 1),
                    )
                    logger.warning(
                        "Blizzard API 429 rate limit on %s, attempt %d, "
                        "backing off %.1fs",
                        path,
                        attempt + 1,
                        backoff,
                    )
                    await asyncio.sleep(backoff)
                    self._retry_count += 1
                    continue

                if resp.status_code >= 500:
                    backoff = self.BASE_BACKOFF * (2**attempt) + random.uniform(
                        0, 1
                    )
                    logger.warning(
                        "Blizzard API %d on %s, attempt %d, backing off %.1fs",
                        resp.status_code,
                        path,
                        attempt + 1,
                        backoff,
                    )
                    await asyncio.sleep(backoff)
                    self._retry_count += 1
                    continue

                resp.raise_for_status()

                body = resp.json()
                new_etag = resp.headers.get("ETag")
                if new_etag and use_etag:
                    await self._set_etag(cache_key, new_etag, body)

                logger.debug(
                    "Blizzard API %d %s (%.0fms, attempt %d)",
                    resp.status_code,
                    path,
                    latency_ms,
                    attempt + 1,
                )
                return body

            except httpx.TimeoutException:
                backoff = self.BASE_BACKOFF * (2**attempt) + random.uniform(0, 1)
                logger.warning(
                    "Blizzard API timeout on %s, attempt %d, backing off %.1fs",
                    path,
                    attempt + 1,
                    backoff,
                )
                await asyncio.sleep(backoff)
                self._retry_count += 1
                continue

        raise RuntimeError(
            f"Blizzard API request failed after {self.MAX_RETRIES + 1} attempts: {path}"
        )

    # ----- Convenience methods for specific endpoints -----

    async def get_connected_realm_index(self) -> list[dict]:
        """
        GET /data/wow/connected-realm/index
        Namespace: dynamic-{region}
        Returns list of connected realm hrefs.
        """
        data = await self.request(
            "/data/wow/connected-realm/index",
            namespace=self._settings.namespace_dynamic,
        )
        return data.get("connected_realms", [])

    async def get_connected_realm(self, realm_id: int) -> dict:
        """
        GET /data/wow/connected-realm/{id}
        Namespace: dynamic-{region}
        Returns connected realm details including member realm list.
        """
        return await self.request(
            f"/data/wow/connected-realm/{realm_id}",
            namespace=self._settings.namespace_dynamic,
        )

    async def get_auctions(self, connected_realm_id: int) -> dict | object:
        """
        GET /data/wow/connected-realm/{id}/auctions
        Namespace: dynamic-{region}
        Returns auction house listings for connected realm.
        May return NOT_MODIFIED if ETag matches.
        """
        return await self.request(
            f"/data/wow/connected-realm/{connected_realm_id}/auctions",
            namespace=self._settings.namespace_dynamic,
            use_etag=True,
        )

    async def get_commodities(self) -> dict | object:
        """
        GET /data/wow/auctions/commodities
        Namespace: dynamic-{region}
        Returns region-wide commodity auctions.
        """
        return await self.request(
            "/data/wow/auctions/commodities",
            namespace=self._settings.namespace_dynamic,
            use_etag=True,
        )

    async def get_item(self, item_id: int) -> dict:
        """
        GET /data/wow/item/{id}
        Namespace: static-{region}
        Returns item metadata (name, quality, level, item_class, etc.)
        """
        return await self.request(
            f"/data/wow/item/{item_id}",
            namespace=self._settings.namespace_static,
            use_etag=True,
        )

    async def get_item_media(self, item_id: int) -> dict:
        """
        GET /data/wow/media/item/{id}
        Namespace: static-{region}
        Returns item media assets (icon URL).
        """
        return await self.request(
            f"/data/wow/media/item/{item_id}",
            namespace=self._settings.namespace_static,
            use_etag=True,
        )

    async def get_profession_index(self) -> list[dict]:
        """
        GET /data/wow/profession/index
        Namespace: static-{region}
        Returns list of professions (id, name).
        """
        data = await self.request(
            "/data/wow/profession/index",
            namespace=self._settings.namespace_static,
        )
        return data.get("professions", [])

    async def get_profession(self, profession_id: int) -> dict:
        """
        GET /data/wow/profession/{id}
        Namespace: static-{region}
        Returns profession detail including skill_tiers list.
        """
        return await self.request(
            f"/data/wow/profession/{profession_id}",
            namespace=self._settings.namespace_static,
        )

    async def get_skill_tier(self, profession_id: int, skill_tier_id: int) -> dict:
        """
        GET /data/wow/profession/{id}/skill-tier/{tierId}
        Namespace: static-{region}
        Returns tier detail with categories -> recipes (id, name).
        """
        return await self.request(
            f"/data/wow/profession/{profession_id}/skill-tier/{skill_tier_id}",
            namespace=self._settings.namespace_static,
        )

    async def get_recipe(self, recipe_id: int) -> dict:
        """
        GET /data/wow/recipe/{id}
        Namespace: static-{region}
        Returns recipe detail: crafted_item, reagents [{reagent, quantity}], crafted_quantity.
        """
        return await self.request(
            f"/data/wow/recipe/{recipe_id}",
            namespace=self._settings.namespace_static,
        )

    async def get_character_professions(self, realm_slug: str, character_name: str) -> dict:
        """
        GET /profile/wow/character/{realmSlug}/{characterName}/professions
        Namespace: profile-{region}
        Public profile data: known professions, skill tiers, and known recipe IDs.
        Works with an app token — no user OAuth required.
        """
        return await self.request(
            f"/profile/wow/character/{realm_slug}/{character_name.lower()}/professions",
            namespace=f"profile-{self._settings.region}",
            use_etag=False,
        )

    def get_metrics(self) -> dict:
        """Return client metrics for observability."""
        return {
            "total_requests": self._request_count,
            "total_retries": self._retry_count,
            "rate_limit_hits": self._rate_limit_count,
        }

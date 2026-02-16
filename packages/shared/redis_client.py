"""
Redis client module -- async Redis wrapper with distributed lock helper.
"""

import redis.asyncio as aioredis
from packages.shared.config import get_settings

_redis_client = None


async def get_redis() -> aioredis.Redis:
    """Get or create the singleton async Redis client."""
    global _redis_client
    if _redis_client is None:
        settings = get_settings()
        _redis_client = aioredis.from_url(
            settings.redis_url,
            decode_responses=True,
            max_connections=20,
        )
    return _redis_client


async def close_redis():
    """Close the Redis connection."""
    global _redis_client
    if _redis_client is not None:
        await _redis_client.aclose()
        _redis_client = None


class DistributedLock:
    """
    Redis-based distributed lock using SETNX + TTL.

    Usage:
        lock = DistributedLock(redis, "lock:item:12345", ttl=60)
        if await lock.acquire():
            try:
                # do work
            finally:
                await lock.release()
    """

    def __init__(self, redis: aioredis.Redis, key: str, ttl: int = 60):
        self.redis = redis
        self.key = f"lock:{key}"
        self.ttl = ttl

    async def acquire(self) -> bool:
        """Attempt to acquire the lock. Returns True if successful."""
        result = await self.redis.set(self.key, "1", nx=True, ex=self.ttl)
        return result is not None and result is not False

    async def release(self):
        """Release the lock."""
        await self.redis.delete(self.key)

    async def __aenter__(self):
        acquired = await self.acquire()
        if not acquired:
            raise RuntimeError(f"Could not acquire lock: {self.key}")
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.release()
        return False

"""Read-only provider inventory; saved secrets never leave the server response."""
import asyncio
import json
import re
from urllib.parse import urlsplit, urlunsplit

import httpx

MAX_RESPONSE = 2 * 1024 * 1024


def model_list_url(base_url: str, protocol: str) -> str:
    if not isinstance(base_url, str) or protocol not in ("openai", "anthropic"):
        raise ValueError("无效的模型列表请求")
    try:
        url = urlsplit(base_url.strip())
        port = url.port
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError()
        path = url.path.rstrip("/")
        if re.search(r"/(?:chat/completions|responses|models|messages)$", path):
            raise ValueError()
        host = url.hostname.lower()
        if ":" in host:
            host = "[" + host + "]"
        if port is not None and port != (443 if url.scheme == "https" else 80):
            host += ":" + str(port)
        suffix = "/v1" if protocol == "anthropic" and not path.endswith("/v1") else ""
        return urlunsplit((url.scheme, host, path + suffix + "/models", "", ""))
    except ValueError:
        raise ValueError("请填写不含凭据、查询参数或具体接口路径的 HTTP(S) API 根地址") from None


async def discover_models(value: dict, saved: dict) -> list[str]:
    if not isinstance(value, dict):
        raise ValueError("无效的模型列表请求")
    protocol = value.get("protocol")
    endpoint = model_list_url(value.get("baseUrl"), protocol)
    key = value.get("apiKey")
    if key is not None and not isinstance(key, str):
        raise ValueError("API Key 格式无效")
    key = (key or "").strip()
    if not key:
        if protocol != saved.get("protocol") or not saved.get("baseUrl") or endpoint != model_list_url(saved["baseUrl"], saved["protocol"]):
            raise ValueError("连接地址或协议已更改，请填写对应的 API Key")
        key = saved.get("apiKey") or ""
    if not key or len(key) > 4096 or any(char in key for char in "\r\n\0"):
        raise ValueError("请填写有效的 API Key")
    headers = {"Authorization": "Bearer " + key}
    if protocol == "anthropic":
        headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
    try:
        async with asyncio.timeout(10):
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                async with client.stream("GET", endpoint, headers=headers) as response:
                    if response.status_code != 200:
                        raise ValueError(f"模型列表接口返回 HTTP {response.status_code}")
                    chunks = bytearray()
                    async for chunk in response.aiter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > MAX_RESPONSE:
                            raise ValueError("模型列表过大，请手动填写 Model ID")
    except (TimeoutError, httpx.TimeoutException):
        raise ValueError("获取模型列表超时") from None
    except httpx.HTTPError:
        raise ValueError("无法连接模型列表接口") from None
    try:
        payload = json.loads(chunks)
    except (ValueError, UnicodeError):
        raise ValueError("接口未返回标准模型列表，请手动填写 Model ID") from None
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise ValueError("接口未返回标准模型列表，请手动填写 Model ID")
    return sorted({item["id"] for item in data if isinstance(item, dict) and isinstance(item.get("id"), str)
                   and 0 < len(item["id"]) <= 200 and not re.search(r"[\s\x00-\x1f]", item["id"])})

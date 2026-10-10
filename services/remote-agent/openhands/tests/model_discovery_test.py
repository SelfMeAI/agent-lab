import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extension"))
from model_discovery import MAX_RESPONSE, discover_models, model_list_url


class ModelDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    saved = {"protocol": "openai", "baseUrl": "https://api.example.com/v1", "apiKey": "saved-fixture-key"}

    async def lookup(self, value, handler):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch("model_discovery.httpx.AsyncClient", return_value=client):
            return await discover_models(value, self.saved)

    async def test_saved_lookup_is_read_only_and_returns_only_model_ids(self):
        def handler(request):
            self.assertEqual(str(request.url), "https://api.example.com/v1/models")
            self.assertEqual(request.headers["authorization"], "Bearer saved-fixture-key")
            return httpx.Response(200, json={"data": [{"id": "model-b"}, {"id": "model-a"}, {"id": "model-a"}, {"id": "invalid model"}]})
        self.assertEqual(await self.lookup({"protocol": "openai", "baseUrl": self.saved["baseUrl"] + "/"}, handler), ["model-a", "model-b"])
        self.assertEqual(self.saved["apiKey"], "saved-fixture-key")

    async def test_new_address_or_protocol_never_receives_saved_key(self):
        def handler(request):
            self.fail("saved credential must not reach another connection")
        for value in ({"protocol": "openai", "baseUrl": "https://other.example"}, {"protocol": "anthropic", "baseUrl": self.saved["baseUrl"]}):
            with self.assertRaisesRegex(ValueError, "已更改"):
                await self.lookup(value, handler)

    async def test_unsaved_key_supports_anthropic_inventory(self):
        def handler(request):
            self.assertEqual(str(request.url), "https://other.example/v1/models")
            self.assertEqual(request.headers["x-api-key"], "new-fixture-key")
            return httpx.Response(200, json={"data": [{"id": "model-a"}]})
        self.assertEqual(await self.lookup({"protocol": "anthropic", "baseUrl": "https://other.example", "apiKey": "new-fixture-key"}, handler), ["model-a"])

    async def test_error_body_is_never_exposed(self):
        with self.assertRaisesRegex(ValueError, "HTTP 401") as caught:
            await self.lookup({"protocol": "openai", "baseUrl": self.saved["baseUrl"]}, lambda request: httpx.Response(401, text="saved-fixture-key"))
        self.assertNotIn("saved-fixture-key", str(caught.exception))

    async def test_oversized_invalid_and_timeout_responses(self):
        value = {"protocol": "openai", "baseUrl": self.saved["baseUrl"]}
        for response, message in ((httpx.Response(200, content=b"a" * (MAX_RESPONSE + 1)), "过大"), (httpx.Response(200, json={"message": "not a model list"}), "标准模型列表")):
            with self.assertRaisesRegex(ValueError, message):
                await self.lookup(value, lambda request: response)
        def timeout(request):
            raise httpx.ReadTimeout("private provider timeout info")
        with self.assertRaisesRegex(ValueError, "获取模型列表超时"):
            await self.lookup(value, timeout)

    def test_url_validation_and_canonicalization(self):
        self.assertEqual(model_list_url("https://API.EXAMPLE.com:443/v1/", "openai"), "https://api.example.com/v1/models")
        self.assertEqual(model_list_url("https://api.example.com", "anthropic"), "https://api.example.com/v1/models")
        for url in ("file:///tmp/model", "https://user:secret@example.com", "https://api.example.com?key=secret", "https://api.example.com/messages"):
            with self.assertRaises(ValueError):
                model_list_url(url, "openai")


if __name__ == "__main__":
    unittest.main()

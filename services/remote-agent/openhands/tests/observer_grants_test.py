"""Single-use, task-bound observation grants; no browser/model/UI state."""

import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import app as deployment


class ObserverGrantsTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(deployment.app)
        self.browser = SimpleNamespace(closed=False, display=SimpleNamespace(port=30123, alive=lambda: True), observer_port=lambda: 30123)
        self.service = SimpleNamespace(get_conversation=lambda: SimpleNamespace())
        self.catalog = SimpleNamespace(get_event_service=AsyncMock(return_value=self.service))
        deployment.tickets.clear()

    def tearDown(self):
        deployment.tickets.clear()
        deployment.app.dependency_overrides.clear()
        self.client.close()

    def grant(self):
        deployment.app.dependency_overrides[deployment.check_session_api_key] = lambda: None
        with patch.object(deployment, "get_conversation_service", return_value=self.catalog), patch.object(deployment, "task_browser", return_value=self.browser):
            response = self.client.post("/api/agent-lab/observer", json={"task": str(uuid4())})
        self.assertEqual(response.status_code, 200, response.text)
        value = response.json()
        self.assertFalse(value["control"])
        return value["wsPath"]

    def rejected(self, path):
        with self.assertRaises(WebSocketDisconnect) as caught:
            with self.client.websocket_connect(path):
                pass
        self.assertEqual(caught.exception.code, 4401)

    def test_missing_expired_closed_and_replaced_resources_reject(self):
        self.rejected("/agent-lab/observe?ticket=missing")
        deployment.tickets["expired"] = (time.time() - 1, self.browser, 30123)
        self.rejected("/agent-lab/observe?ticket=expired")
        path = self.grant()
        self.browser.closed = True
        self.rejected(path)
        self.browser.closed = False
        path = self.grant()
        self.browser.display.port = 30124
        self.rejected(path)

    def test_grant_connects_only_its_own_task_port_and_cannot_be_reused(self):
        path = self.grant()
        reader = SimpleNamespace(read=AsyncMock(side_effect=[b"RFB 003.008\n", b""]))
        writer = SimpleNamespace(write=MagicMock(), drain=AsyncMock(), close=MagicMock(), wait_closed=AsyncMock())
        connection = AsyncMock(return_value=(reader, writer))
        with patch.object(deployment.asyncio, "open_connection", connection):
            with self.client.websocket_connect(path, subprotocols=["binary"]) as stream:
                self.assertEqual(stream.receive_bytes(), b"RFB 003.008\n")
        connection.assert_awaited_once_with("127.0.0.1", 30123)
        self.rejected(path)


if __name__ == "__main__":
    unittest.main()

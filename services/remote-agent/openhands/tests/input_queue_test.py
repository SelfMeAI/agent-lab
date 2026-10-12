import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extension"))
sys.dont_write_bytecode = True
from input_queue import InputQueues, InputStopped


class Driver:
    def __init__(self):
        self.value = "running"
        self.calls = []
        self.receipts = set()
        self.service = self
        self.fail = False

    def status(self):
        return self.value

    def receipt(self, key):
        return key in self.receipts

    async def send(self, body, key, steer, current):
        if not current():
            raise InputStopped()
        if self.fail:
            raise RuntimeError("provider unavailable")
        if key not in self.receipts:
            self.calls.append((body, key, steer))
            self.receipts.add(key)
        self.value = "running"
        return True

    async def interrupt(self):
        self.value = "paused"

    async def stop(self):
        await self.interrupt()


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        base = Path.cwd() / ".work/remote-agent"
        base.mkdir(parents=True, exist_ok=True)
        self.folder = tempfile.TemporaryDirectory(prefix="oh-queue-test-", dir=base)
        self.path = str(Path(self.folder.name) / "inputs.sqlite")
        self.q = InputQueues(self.path)
        self.driver = Driver()
        self.q.drivers["a"] = self.driver

    async def asyncTearDown(self):
        await self.q.close()
        self.folder.cleanup()

    async def wait(self, condition):
        async with asyncio.timeout(3):
            while not condition():
                await asyncio.sleep(.02)

    def send(self, text, mode="queue", key=None):
        return self.q.send("a", key or str(uuid4()), text, [], mode)

    async def test_merge_after_whole_turn_not_tool_or_approval(self):
        self.send("one"); self.send("two")
        await asyncio.sleep(.25)
        self.driver.value = "waiting"
        await asyncio.sleep(.25)
        self.assertEqual(self.driver.calls, [])
        self.driver.value = "completed"
        await self.wait(lambda: not self.q.state("a")["items"])
        self.assertEqual(self.driver.calls[0][0], "one\n\ntwo")

    async def test_steer_bypasses_pending_peers(self):
        pending = self.send("later")["items"][0]["id"]
        self.send("now", "steer")
        await self.wait(lambda: len(self.driver.calls) == 1)
        self.assertEqual(self.driver.calls[0][::2], ("now", True))
        self.assertEqual([row["id"] for row in self.q.state("a")["items"]], [pending])
        await self.q.action("a", pending, "steer")
        await self.wait(lambda: len(self.driver.calls) == 2)

    async def test_stop_retains_then_continue_merges(self):
        self.send("one"); self.send("two")
        await self.q.control("a", "stop")
        self.driver.value = "completed"
        await asyncio.sleep(.25)
        self.assertEqual(self.driver.calls, [])
        await self.q.control("a", "resume")
        self.assertIn("one\n\ntwo", self.driver.calls[0][0])

    async def test_error_holds_queue(self):
        self.send("later"); self.driver.value = "error"
        await self.wait(lambda: self.q.state("a")["paused"])
        self.driver.value = "completed"
        self.q.kick("a"); await asyncio.sleep(.1)
        self.assertEqual(self.driver.calls, [])

    async def test_fresh_message_after_stop_with_no_queue_starts_normally(self):
        await self.q.control("a", "stop")
        self.send("new requirement", "steer")
        await self.wait(lambda: len(self.driver.calls) == 1)
        self.assertEqual(self.driver.calls[0][::2], ("new requirement", False))
        self.assertFalse(self.q.state("a")["paused"])

    async def test_message_and_mode_are_per_task_and_idempotent(self):
        key = str(uuid4()); self.send("once", key=key); self.send("once", key=key)
        self.assertEqual(len(self.q.state("a")["items"]), 1)
        with self.assertRaisesRegex(ValueError, "其他内容"):
            self.send("different", key=key)
        with self.assertRaisesRegex(ValueError, "先处理"):
            self.q.mode("a", "steer")
        await self.q.action("a", key, "remove")
        self.q.mode("a", "steer")
        self.assertEqual(self.q.state("b")["mode"], "queue")

    async def test_failure_retry_uses_same_dispatch_marker(self):
        self.driver.value = "idle"; self.driver.fail = True
        self.send("keep")
        await self.wait(lambda: self.q.state("a")["paused"])
        key = self.q.dispatch("a")["id"]
        self.driver.fail = False
        await self.q.control("a", "resume")
        self.assertEqual(self.driver.calls[0][1], key)
        self.assertEqual(len(self.driver.calls), 1)

    async def test_restart_retains_and_requires_recovery(self):
        self.q.mode("a", "steer"); self.send("persistent")
        await self.q.close(); self.q = InputQueues(self.path)
        self.q.drivers["a"] = self.driver
        self.assertTrue(self.q.state("a")["paused"])
        self.assertEqual(self.q.state("a")["mode"], "steer")
        self.assertEqual(self.q.state("a")["items"][0]["text"], "persistent")
        self.driver.value = "idle"
        await self.q.control("a", "resume")
        self.assertFalse(self.q.state("a")["items"])

    async def test_clear_does_not_resurrect(self):
        self.send("gone"); await self.q.clear("a")
        self.assertNotIn("a", self.q.drivers)
        with self.assertRaisesRegex(ValueError, "任务已删除"):
            self.q.state("a")
        self.q.drivers["a"] = self.driver  # A late native lookup must not reopen it.
        with self.assertRaisesRegex(ValueError, "任务已删除"):
            self.send("late request")
        self.assertFalse(self.q.state("new")["items"])
        await self.q.clear("a")

    async def test_count_limit_retains_existing(self):
        for i in range(20): self.send(str(i))
        with self.assertRaisesRegex(ValueError, "20 条"):
            self.send("overflow")
        self.assertEqual(len(self.q.state("a")["items"]), 20)


if __name__ == "__main__":
    unittest.main()

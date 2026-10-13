"""Conversation-scoped deployment resources around the unmodified SDK tools.

The upstream default shares one executor process-wide (for parent/subagents).
This server hosts independent conversations in that process, so each needs its
own executor, Chromium profile, X display and read-only observation endpoint.
No replacement agent loop, browser actions, approvals or model calls.
"""

import contextlib
import json
import os
import select
import socket
import subprocess
import threading
import time
from uuid import UUID

import psutil
from openhands.sdk.tool import register_tool
from openhands.tools.browser_use.definition import (
    BrowserGetContentAction,
    BrowserGetStateAction,
    BrowserListTabsAction,
    BrowserNavigateAction,
    BrowserObservation,
    BrowserToolSet,
)
from openhands.tools.browser_use.impl import BrowserToolExecutor


def task_key(value) -> str:
    return str(UUID(str(value)))


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


class TaskDisplay:
    """Only these owned child processes can be stopped, never a global pkill."""

    def __init__(self):
        self.xvfb = None
        self.vnc = None
        self.name = ""
        self.port = 0

    def start(self):
        ready_read, ready_write = os.pipe()
        try:
            self.xvfb = subprocess.Popen(
                ["Xvfb", "-displayfd", str(ready_write), "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
                pass_fds=(ready_write,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        finally:
            os.close(ready_write)
        try:
            ready, _, _ = select.select([ready_read], [], [], 10)
            number = os.read(ready_read, 64).strip() if ready else b""
            if not number.isdigit():
                raise RuntimeError("此任务的浏览器显示服务未就绪，请重新连接")
            self.name = ":" + number.decode("ascii")
        except BaseException:
            self.close()
            raise
        finally:
            os.close(ready_read)
        self.start_vnc()

    def start_vnc(self):
        stop_process(self.vnc)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        self.vnc = subprocess.Popen(
            ["x11vnc", "-display", self.name, "-localhost", "-rfbport", str(self.port), "-nopw", "-shared", "-forever", "-viewonly"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 10
        try:
            while True:
                if self.vnc.poll() is not None:
                    raise RuntimeError("此任务的浏览器观察服务启动失败，请重新连接")
                try:
                    with socket.create_connection(("127.0.0.1", self.port), timeout=1) as probe:
                        if probe.recv(12).startswith(b"RFB "):
                            return
                except OSError:
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("此任务的浏览器观察服务未就绪，请重新连接")
                time.sleep(0.05)
        except BaseException:
            self.close()
            raise

    def alive(self):
        return bool(self.xvfb and self.xvfb.poll() is None and self.vnc and self.vnc.poll() is None)

    def close(self):
        for process in (self.vnc, self.xvfb):
            with contextlib.suppress(OSError, subprocess.TimeoutExpired):
                stop_process(process)
        self.vnc = self.xvfb = None


_pool_lock = threading.RLock()
_executors: dict[str, "TaskBrowserExecutor"] = {}


class TaskBrowserExecutor(BrowserToolExecutor):
    def __init__(self, key, **config):
        self.key = key
        self.display = TaskDisplay()
        self._task_lock = threading.RLock()
        self.closed = False
        self._last_url = ""
        try:
            self.display.start()
            config.setdefault("window_size", {"width": 1280, "height": 800})
            config.setdefault("viewport", {"width": 1280, "height": 720})
            # The task marker becomes DISPLAY only in Chromium's own launcher.
            args = [arg for arg in config.pop("args", []) if not arg.startswith("--agent-lab-x11-display=")]
            super().__init__(**{
                **config, "headless": False, "chromium_sandbox": False,
                "executable_path": "/opt/agent-lab/chromium-task",
                "args": [*args, "--disable-gpu", "--disable-dev-shm-usage", "--agent-lab-x11-display=" + self.display.name],
            })
        except BaseException:
            self.display.close()
            raise

    def _process_dead(self):
        if not self._initialized:
            return False
        session = self._server.browser_session
        if session is None:
            return True
        process = getattr(getattr(session, "_local_browser_watchdog", None), "_subprocess", None)
        if process is None:
            # After a crash the native watchdog can clear its process before
            # the session object disappears. This initialized, locally-owned
            # browser has then died too; do not send a stale DOM action to it.
            return True
        try:
            return not process.is_running() or process.status() == psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return True

    def _reset_browser(self):
        # Only this task's SDK instance. Never restart another task or retry a
        # mutating click/type/submit against stale DOM indices.
        with contextlib.suppress(Exception):
            self._async_executor.run_async(self.cleanup, timeout=5)
        self._server.browser_session = None
        self._initialized = False

    def __call__(self, action, *args, **kwargs):
        with self._task_lock:
            if self.closed:
                return BrowserObservation.from_text(text="此任务的浏览器已关闭，请重新打开任务", is_error=True)
            recovered = self._process_dead()
            if not self.display.xvfb or self.display.xvfb.poll() is not None:
                recovered = True
                self._reset_browser()
                self.display.close()
                self.display.start()
                self._config["args"] = [arg for arg in self._config["args"] if not arg.startswith("--agent-lab-x11-display=")]
                self._config["args"].append("--agent-lab-x11-display=" + self.display.name)
            elif recovered:
                self._reset_browser()
            if not self.display.vnc or self.display.vnc.poll() is not None:
                self.display.start_vnc()
            if recovered and not isinstance(action, BrowserNavigateAction):
                if self._last_url:
                    restored = super().__call__(BrowserNavigateAction(url=self._last_url))
                    if restored.is_error:
                        return restored
                if not isinstance(action, (BrowserGetStateAction, BrowserGetContentAction, BrowserListTabsAction)):
                    return BrowserObservation.from_text(text="浏览器已恢复，请重新观察页面后再操作；刚才的操作没有重试", is_error=True)
            result = super().__call__(action, *args, **kwargs)
            if not result.is_error:
                if isinstance(action, BrowserNavigateAction):
                    self._last_url = action.url
                elif isinstance(action, BrowserGetStateAction):
                    with contextlib.suppress(ValueError, TypeError):
                        self._last_url = json.loads(result.text).get("url") or self._last_url
            return result

    def observer_port(self):
        # Serialize startup/recovery with this browser's own native actions.
        # An already-live screen does not need a new SDK tool call.
        if not self.closed and self._initialized and not self._process_dead() and self.display.alive():
            return self.display.port
        with self._task_lock:
            if self.closed:
                raise RuntimeError("此任务的浏览器已关闭，请重新打开任务")
            if not self._initialized or self._process_dead() or not self.display.alive():
                result = self(BrowserListTabsAction())
                if result.is_error:
                    raise RuntimeError("此任务的浏览器启动失败，请重新连接")
            return self.display.port

    def close(self):
        lock = getattr(self, "_task_lock", None)
        if lock is None:
            return
        with lock:
            if self.closed:
                return
            self.closed = True
            with _pool_lock:
                if _executors.get(self.key) is self:
                    del _executors[self.key]
            try:
                if hasattr(self, "_async_executor"):
                    super().close()
            finally:
                self.display.close()


class TaskBrowserToolSet(BrowserToolSet):
    @classmethod
    def _get_or_create_shared_executor(cls, conv_state, **config):
        key = task_key(conv_state.id)
        with _pool_lock:
            existing = _executors.get(key)
            if existing is not None and not existing.closed:
                return existing
            executor = TaskBrowserExecutor(key, full_output_save_dir=conv_state.env_observation_persistence_dir, **config)
            _executors[key] = executor
            return executor


def task_browser(value):
    with _pool_lock:
        return _executors.get(task_key(value))


def close_task_browsers():
    with _pool_lock:
        browsers = list(_executors.values())
    for browser in browsers:
        with contextlib.suppress(Exception):
            browser.close()


# Public SDK registration keeps the same tool spec and native action schemas.
# Old persisted conversations therefore resume without rewriting their data.
register_tool(BrowserToolSet.name, TaskBrowserToolSet)

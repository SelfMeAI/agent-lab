"""Three simultaneous SDK browsers; no model, credentials or external pages.

Run in the actual deployment image, with only this test folder mounted read-
only and a disposable output directory. Production service data is untouched.
"""

import base64
import io
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from PIL import Image
from openhands.sdk.tool.registry import registered_tool_class
from openhands.tools.browser_use.definition import BrowserClickAction, BrowserGetContentAction, BrowserGetStateAction, BrowserNavigateAction, BrowserToolSet
from task_browser import TaskBrowserToolSet, close_task_browsers, task_browser
from desktop_fixture import DesktopFixture


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        marker = self.path.strip("/")[:16]
        body = (f'<!doctype html><meta charset="utf-8"><title>Session {marker}</title>'
                '<style>body{font:30px sans-serif;background:white;color:black;margin:40px}'
                '#emoji{position:absolute;left:40px;top:150px;font:64px "Noto Color Emoji",sans-serif}'
                'h1{margin:0;font-size:48px}p{margin:10px 0}</style>'
                f'<h1>独立会话 {marker}</h1><p>Only {marker} owns this page</p>'
                '<div id="emoji">😀 🚀 ❤️ 👍🏽 👩‍💻 🇨🇳</div>').encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def checked(executor, action):
    result = executor(action)
    assert not result.is_error, result.text[:2000]
    return result


def screenshot(executor, output, name):
    result = checked(executor, BrowserGetStateAction(include_screenshot=True))
    assert result.screenshot_data
    raw = base64.b64decode(result.screenshot_data)
    output.joinpath(name + "-native.png").write_bytes(raw)
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    # Only the fixture emoji row, not colored browser toolbar/extension icons.
    colorful = sum(max(pixel) - min(pixel) > 50 for pixel in image.crop((20, 140, min(image.width, 850), min(image.height, 280))).getdata())
    assert colorful > 500, f"Emoji row lacks colored glyphs: {colorful}"
    return colorful


output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
pool = []
observers = []
original_display = os.environ.get("DISPLAY")
try:
    assert registered_tool_class(BrowserToolSet.name) is TaskBrowserToolSet
    font = subprocess.check_output(["fc-match", "-f", "%{file}", "emoji"], text=True)
    assert font.startswith("/usr/share/fonts/") and "NotoColorEmoji" in font, font
    for name in ("ALPHA", "BETA", "GAMMA"):
        key = uuid4()
        state = SimpleNamespace(id=key, env_observation_persistence_dir=str(output / name))
        executor = TaskBrowserToolSet._get_or_create_shared_executor(state)
        assert executor is TaskBrowserToolSet._get_or_create_shared_executor(state)
        assert executor is task_browser(str(key))
        pool.append((name, key, executor))
    assert len({ex.display.name for _, _, ex in pool}) == 3, "Displays are shared"
    assert len({ex.display.port for _, _, ex in pool}) == 3, "Observation ports are shared"
    assert len({ex._config["user_data_dir"] for _, _, ex in pool}) == 3, "Profiles are shared"
    assert os.environ.get("DISPLAY") == original_display, "Task launch changed the shared server environment"
    with ThreadPoolExecutor(max_workers=3) as jobs:
        futures = [jobs.submit(checked, ex, BrowserNavigateAction(url=f"http://127.0.0.1:{server.server_port}/{name}")) for name, _, ex in pool]
        for future in futures:
            future.result(timeout=90)
    colors = {}
    frames = []
    for name, _, executor in pool:
        content = checked(executor, BrowserGetContentAction()).text
        assert f"Only {name} owns this page" in content
        assert all(f"Only {other} owns this page" not in content for other, _, _ in pool if other != name)
        colors[name] = screenshot(executor, output, name)
        entered, released = threading.Event(), threading.Event()
        def simulate_busy_tool():
            with executor._task_lock:
                entered.set()
                released.wait(timeout=5)
        busy_tool = threading.Thread(target=simulate_busy_tool)
        busy_tool.start()
        assert entered.wait(timeout=2)
        try:
            started = time.monotonic()
            assert executor.observer_port() == executor.display.port, "A live observer waited for tool completion"
            assert time.monotonic() - started < 0.5, "A live observer blocked behind a running tool"
        finally:
            released.set()
            busy_tool.join(timeout=2)
        observer = DesktopFixture()
        observer.attach(executor.observer_port())
        observers.append(observer)
        frame = base64.b64decode(observer.screenshot())
        frames.append(frame)
        output.joinpath(name + "-observer.png").write_bytes(frame)
    assert len(set(frames)) == 3, "Task observation endpoints return the same shared display"
    # Closing/deleting one task must not stop the other native browser.
    beta = pool[1][2]
    beta_pid = beta._server.browser_session._local_browser_watchdog._subprocess.pid
    pool[0][2].close()
    assert task_browser(pool[0][1]) is None
    assert "Only BETA owns this page" in checked(beta, BrowserGetContentAction()).text
    assert beta_pid == beta._server.browser_session._local_browser_watchdog._subprocess.pid, "Closing ALPHA restarted BETA"
    # Recovery is scoped; it restores the target, never replays mutating tools.
    crashed = beta._server.browser_session._local_browser_watchdog._subprocess
    crashed.kill()
    crashed.wait(timeout=5)
    recovered = checked(beta, BrowserGetStateAction(include_screenshot=True))
    assert "BETA" in recovered.text, recovered.text[:2000]
    assert beta._server.browser_session._local_browser_watchdog._subprocess.pid != beta_pid
    assert "Only GAMMA owns this page" in checked(pool[2][2], BrowserGetContentAction()).text
    crashed = beta._server.browser_session._local_browser_watchdog._subprocess
    crashed.kill()
    crashed.wait(timeout=5)
    stale_click = beta(BrowserClickAction(index=0))
    assert stale_click.is_error and "没有重试" in stale_click.text, stale_click.text[:2000]
    assert "Only BETA owns this page" in checked(beta, BrowserGetContentAction()).text
    # A broken observation process recovers without restarting Chromium.
    gamma = pool[2][2]
    gamma_pid = gamma._server.browser_session._local_browser_watchdog._subprocess.pid
    gamma.display.vnc.kill()
    gamma.display.vnc.wait(timeout=5)
    new_port = gamma.observer_port()
    assert gamma.display.alive() and new_port > 0
    assert gamma._server.browser_session._local_browser_watchdog._subprocess.pid == gamma_pid, "Restarting VNC restarted Chromium"
    gamma.display.xvfb.kill()
    gamma.display.xvfb.wait(timeout=5)
    assert gamma.observer_port() > 0 and gamma.display.alive()
    assert "Only GAMMA owns this page" in checked(gamma, BrowserGetContentAction()).text
    assert os.environ.get("DISPLAY") == original_display
    print(json.dumps({"passed": True, "independent_sessions": 3, "independent_profiles": True, "independent_observer_frames": True,
                      "close_isolated": True, "browser_crash_recovered": True, "observer_crash_recovered": True,
                      "display_crash_recovered": True, "stale_mutating_action_not_replayed": True,
                      "live_observation_does_not_wait_for_tool": True,
                      "system_emoji_font": font, "color_emoji_pixels": colors, "model_calls": 0}))
finally:
    for observer in observers:
        observer.close()
    close_task_browsers()
    server.shutdown()

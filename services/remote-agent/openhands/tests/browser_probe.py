"""Exercise the pinned native browser tool inside its Linux source image.

No model key, external website, host browser, or host task directory is used.
This verifies browser primitives, not a completed model-driven agent task.
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from openhands.tools.browser_use.definition import (
    BrowserClickAction,
    BrowserGetContentAction,
    BrowserGetStateAction,
    BrowserNavigateAction,
)
from openhands.tools.browser_use.impl import BrowserToolExecutor


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"""<!doctype html><meta charset="utf-8"><title>Remote browser proof</title>
        <style>body{font:24px sans-serif;background:#111827;color:#fff;padding:60px}
        button{font:inherit;padding:16px;border-radius:12px}</style>
        <main><h1>Remote browser proof</h1><p id="result">Waiting for native tool click</p>
        <button onclick="this.textContent='Native click verified';document.getElementById('result').textContent='Native click verified'">Probe action</button></main>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def checked(executor, action):
    result = executor(action)
    if result.is_error:
        raise RuntimeError(f"{type(action).__name__}: {result.text[:2000]}")
    return result


server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
# Docker provides the execution boundary. Its default seccomp policy cannot
# run Chromium's user-namespace sandbox. Do not infer public SaaS safety here.
desktop = None
executor = None
try:
    if os.environ.get("SELFME_DESKTOP_PROBE") == "1":
        from desktop_fixture import DesktopFixture
        desktop = DesktopFixture()
        desktop.start()
    executor = BrowserToolExecutor(headless=desktop is None, chromium_sandbox=False)
    checked(executor, BrowserNavigateAction(url=f"http://127.0.0.1:{server.server_port}/"))
    state = checked(executor, BrowserGetStateAction(include_screenshot=True))
    assert state.screenshot_data, "Native tool did not return a screenshot"
    # Use the index supplied by the native DOM observation, never a guess.
    elements = json.loads(state.text).get("interactive_elements", [])
    button = next((element for element in elements if element.get("tag") == "button" and element.get("text") == "Probe action"), None)
    if button is None or not isinstance(button.get("index"), int):
        raise RuntimeError(f"Cannot locate fixture button in native DOM: {state.text[:3000]}")
    desktop_before = desktop.screenshot() if desktop else None
    checked(executor, BrowserClickAction(index=button["index"]))
    after = checked(executor, BrowserGetStateAction(include_screenshot=True))
    assert after.screenshot_data, "Native observation disappeared after click"
    content = checked(executor, BrowserGetContentAction())
    click_verified = any(element.get("text") == "Native click verified" for element in json.loads(after.text).get("interactive_elements", []))
    desktop_after = desktop.screenshot() if desktop else None
    desktop_verified = bool(desktop and desktop.stream_verified and desktop_before != desktop_after)
    print(json.dumps({
        "probe": "openhands-native-browser",
        "passed": click_verified and (desktop is None or desktop_verified),
        "navigate": True,
        "dom_observation": True,
        "native_click": click_verified,
        "screenshot": True,
        "headful_browser": desktop is not None,
        "continuous_desktop_stream": desktop_verified if desktop else "not-tested",
        "observer_scope": "read-only RFB / noVNC deployment proof" if desktop else None,
        "human_takeover": "not-tested",
        "model_driven_task": "not-tested",
        "screenshots": {"before": state.screenshot_data, "after": after.screenshot_data, **({"desktop-before": desktop_before, "desktop-after": desktop_after} if desktop else {})},
        "before_observation": json.loads(state.text),
        "after_observation": json.loads(after.text),
        "content_extract": content.text[:3000],
    }))
    assert click_verified, "Native click did not change the fixture"
    assert desktop is None or desktop_verified, "Observer did not see the native browser change"
finally:
    if executor:
        executor.close()
    if desktop:
        desktop.close()
    server.shutdown()

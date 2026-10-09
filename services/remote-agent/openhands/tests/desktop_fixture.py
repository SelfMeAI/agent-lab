"""Observe the native headful browser over container-local RFB and noVNC.

Test-only, read-only observer. No public port or host screen is involved.
Human takeover, input arbitration and public SaaS isolation are NOT tested.
"""

import base64
import io
import os
import socket
import struct
import subprocess
import time
from urllib.request import urlopen

from PIL import Image


def read_exact(connection, count):
    result = bytearray()
    while len(result) < count:
        chunk = connection.recv(count - len(result))
        if not chunk:
            raise RuntimeError("Observer connection closed")
        result.extend(chunk)
    return bytes(result)


class DesktopFixture:
    def __init__(self):
        self.processes = []
        self.connection = None
        self.width = self.height = 0
        self.stream_verified = False

    def start(self):
        os.environ["DISPLAY"] = ":77"
        self.spawn(["Xvfb", ":77", "-screen", "0", "1280x800x24", "-nolisten", "tcp"])
        deadline = time.monotonic() + 10
        while not os.path.exists("/tmp/.X11-unix/X77"):
            if time.monotonic() > deadline:
                raise RuntimeError("Private X11 display did not start")
            time.sleep(0.1)
        self.spawn(["x11vnc", "-display", ":77", "-localhost", "-rfbport", "5900", "-nopw", "-shared", "-forever", "-viewonly"])
        self.spawn(["websockify", "--web", "/usr/share/novnc", "127.0.0.1:6080", "127.0.0.1:5900"])
        self.connection = self.connect(5900)
        version = read_exact(self.connection, 12)
        assert version.startswith(b"RFB 003."), "Not a native RFB connection"
        self.connection.sendall(b"RFB 003.008\n")
        types = read_exact(self.connection, read_exact(self.connection, 1)[0])
        assert 1 in types, "Test-only local RFB did not offer the expected observer route"
        self.connection.sendall(b"\x01")
        assert read_exact(self.connection, 4) == b"\0\0\0\0"
        self.connection.sendall(b"\x01")
        header = read_exact(self.connection, 24)
        self.width, self.height = struct.unpack("!HH", header[:4])
        read_exact(self.connection, struct.unpack("!I", header[20:24])[0])
        pixel_format = struct.pack("!BBBBHHHBBBxxx", 32, 24, 0, 1, 255, 255, 255, 16, 8, 0)
        self.connection.sendall(b"\0\0\0\0" + pixel_format)
        self.connection.sendall(struct.pack("!BBHi", 2, 0, 1, 0))
        self.verify_websocket()

    def spawn(self, args):
        process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append(process)

    def connect(self, port):
        deadline = time.monotonic() + 15
        while True:
            try:
                return socket.create_connection(("127.0.0.1", port), timeout=8)
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError(f"Private observer port {port} did not start")
                time.sleep(0.1)

    def verify_websocket(self):
        with self.connect(6080) as connection:
            key = base64.b64encode(os.urandom(16)).decode()
            connection.sendall((f"GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:6080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n\r\n").encode())
            headers = bytearray()
            while not headers.endswith(b"\r\n\r\n"):
                headers.extend(read_exact(connection, 1))
                if len(headers) > 8192:
                    raise RuntimeError("Invalid observer handshake")
            assert b" 101 " in headers.split(b"\r\n", 1)[0]
            frame = read_exact(connection, 2)
            assert frame[0] & 15 == 2, "Observer did not send a binary framebuffer stream"
            length = frame[1] & 127
            if length == 126:
                length = struct.unpack("!H", read_exact(connection, 2))[0]
            elif length == 127:
                length = struct.unpack("!Q", read_exact(connection, 8))[0]
            assert length <= 8192, "Invalid initial framebuffer frame"
            assert read_exact(connection, length).startswith(b"RFB 003.")
        with urlopen("http://127.0.0.1:6080/vnc.html", timeout=5) as response:
            assert response.status == 200, "noVNC observer page unavailable"
        self.stream_verified = True

    def screenshot(self):
        time.sleep(0.3)  # Allow the X11 paint after the verified native DOM action.
        self.connection.sendall(struct.pack("!BBHHHH", 3, 0, 0, 0, self.width, self.height))
        canvas = Image.new("RGB", (self.width, self.height))
        while True:
            message = read_exact(self.connection, 1)[0]
            if message == 2:  # Bell
                continue
            if message == 3:  # ServerCutText
                header = read_exact(self.connection, 7)
                read_exact(self.connection, struct.unpack("!I", header[3:])[0])
                continue
            assert message == 0, f"Unexpected framebuffer message {message}"
            update = read_exact(self.connection, 3)
            for _ in range(struct.unpack("!H", update[1:])[0]):
                x, y, width, height, encoding = struct.unpack("!HHHHi", read_exact(self.connection, 12))
                assert encoding == 0, f"Unexpected negotiated framebuffer encoding {encoding}"
                pixels = read_exact(self.connection, width * height * 4)
                canvas.paste(Image.frombytes("RGB", (width, height), pixels, "raw", "BGRX"), (x, y))
            break
        output = io.BytesIO()
        canvas.save(output, format="PNG")
        return base64.b64encode(output.getvalue()).decode()

    def close(self):
        if self.connection:
            self.connection.close()
        for process in reversed(self.processes):
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

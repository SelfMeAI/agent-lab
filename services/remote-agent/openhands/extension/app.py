"""Deployment-only files and a read-only framebuffer, alongside the native SDK.

No replacement agent loop. Native authentication, persistence, tool execution,
confirmation and ordered session sockets remain unchanged.
"""
import asyncio
import contextlib
import json
import os
import secrets
import time
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, Response
from openhands.agent_server.api import create_app
from openhands.agent_server.dependencies import check_session_api_key, get_conversation_service
from openhands.agent_server._secrets_exposure import get_config
from openhands.agent_server.persistence import get_settings_store
from model_discovery import discover_models
from task_browser import close_task_browsers, task_browser
from input_queue import InputQueues
from legacy_state import migrate_owned_volume, private_file

migrate_owned_volume()
app = create_app()
router = APIRouter(prefix="/api/agent-lab", dependencies=[Depends(check_session_api_key)])
tasks = Path("/workspace/agent-lab/tasks")
tickets: dict[str, tuple[float, object, int]] = {}
native_lifespan = app.router.lifespan_context


@contextlib.asynccontextmanager
async def queue_lifespan(application):
    async with native_lifespan(application):
        try:
            yield
        finally:
            if queues := getattr(application.state, "agent_lab_inputs", None):
                await queues.close()


app.router.lifespan_context = queue_lifespan


async def input_service(request, task):
    task = identity(task)
    task_root(task)
    service = await get_conversation_service(request).get_event_service(UUID(task))
    if service is None:
        raise HTTPException(404, "任务不存在或已删除")
    queues = getattr(app.state, "agent_lab_inputs", None)
    if queues is None:
        queues = app.state.agent_lab_inputs = InputQueues("/workspace/.agent-lab-inputs/queue.sqlite")
    try:
        queues.ensure(task)
    except ValueError:
        raise HTTPException(404, "任务不存在或已删除") from None
    queues.bind(task, service)
    return queues, task


@router.get("/inputs")
async def input_state(request: Request, task: str):
    queues, task = await input_service(request, task)
    queues.kick(task)
    return queues.state(task)


@router.post("/inputs/{operation}")
async def input_action(request: Request, operation: str):
    if len(await request.body()) > 600_000:
        raise HTTPException(413, "消息请求过大")
    try:
        value = await request.json()
        queues, task = await input_service(request, value.get("task", ""))
        if operation == "mode":
            return queues.mode(task, value.get("mode"))
        if operation == "send":
            files = value.get("files", [])
            if not isinstance(files, list) or len(files) > 10:
                raise ValueError("附件无效")
            verified = []
            for file in files:
                if not isinstance(file, dict) or not isinstance(file.get("name"), str) or not isinstance(file.get("path"), str) or not file["path"].startswith("uploads/") or str(target(task, file["path"])) != file.get("absolutePath"):
                    raise ValueError("附件不属于此任务，请重新上传")
                verified.append({"name": file["name"][:160], "path": file["path"], "absolutePath": file["absolutePath"]})
            return queues.send(task, value.get("requestId"), value.get("text"), verified, value.get("mode"))
        if operation in ("remove", "steer"):
            return await queues.action(task, value.get("messageId"), operation)
        if operation == "control":
            return await queues.control(task, value.get("action"))
        if operation == "clear":
            await queues.clear(task)
            return {"ok": True}
        raise ValueError("待发操作无效")
    except (ValueError, TypeError, AttributeError) as error:
        raise HTTPException(400, str(error)) from None


@router.post("/models")
async def provider_models(request: Request):
    # Same authenticated native settings store; no copied/fallback desktop keys.
    if len(body := await request.body()) > 16384:
        raise HTTPException(413, "模型列表请求过大")
    try:
        value = await request.json()
        settings = get_settings_store(get_config(request)).load()
        llm = getattr(settings.agent_settings, "llm", None) if settings else None
        model = llm.model if llm else ""
        key = llm.api_key.get_secret_value() if llm and llm.api_key else None
        saved = {"protocol": "anthropic" if model.startswith("anthropic/") else "openai", "baseUrl": llm.base_url if llm else "", "apiKey": key}
        return {"models": await discover_models(value, saved)}
    except ValueError as error:
        # Our errors contain statuses only, never provider bodies or credentials.
        raise HTTPException(400, str(error)) from None


def identity(value: str) -> str:
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(400, "任务标识无效")


def relative_file(value: str) -> str:
    if "\x00" in value or "\\" in value or value.startswith("/") or any(p == ".." or private_file(p) for p in value.split("/")):
        raise HTTPException(400, "文件路径无效")
    return value


def task_root(value: str) -> Path:
    directory = tasks / identity(value)
    if not directory.is_dir() or directory.is_symlink():
        raise HTTPException(404, "任务工作区不存在")
    return directory.resolve()


def target(value: str, file: str) -> Path:
    directory = task_root(value)
    path = (directory / relative_file(file)).resolve()
    if path != directory and not path.is_relative_to(directory):
        raise HTTPException(400, "文件超出任务工作区")
    return path


@router.post("/workspace")
async def prepare(request: Request):
    value = identity((await request.json()).get("id", ""))
    directory = tasks / value
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink():
        raise HTTPException(400, "任务工作区不能是符号链接")
    return {"root": str(directory)}


@router.get("/files")
async def files(task: str, path: str = "", op: str = "get"):
    file = target(task, path)
    if op == "list":
        if not file.is_dir():
            raise HTTPException(404, "目录不存在")
        entries = sorted(file.iterdir(), key=lambda item: (not item.is_dir(), item.name))
        result = []
        for item in entries[:500]:
            if item.is_symlink() or private_file(item.name):
                continue
            info = item.stat()
            result.append({"path": str(item.relative_to(task_root(task))), "name": item.name, "directory": item.is_dir(), "size": info.st_size, "modifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(info.st_mtime))})
        return {"path": path, "files": result, "truncated": len(entries) > 500}
    if not file.is_file() or file.stat().st_size > 64 * 1024 * 1024:
        raise HTTPException(400, "文件不存在，或超过 64 MB 下载上限")
    if op == "preview":
        # Separate document renderer. Never execute a conversation/tool/model,
        # write back to the source, or pass native model keys to the helper.
        environment = {key: os.environ[key] for key in ("PATH", "LANG", "AGENT_LAB_DOCUMENT_PREVIEW_URL") if key in os.environ}
        process = await asyncio.create_subprocess_exec("node", "/opt/document-preview/office-preview-cli.mjs", str(file), env=environment, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, error = await asyncio.wait_for(process.communicate(), timeout=75)
        except (TimeoutError, asyncio.CancelledError):
            if process.returncode is None:
                process.kill()
            await process.communicate()
            raise HTTPException(503, "文档预览转换超时，请重试；也可以下载原文件。") from None
        if process.returncode:
            try:
                detail = json.loads(error[:4096])
                status = detail.get("status", 500)
                message = detail.get("message", "暂时无法生成文档预览，可以下载原文件。")
            except (ValueError, TypeError):
                status, message = 500, "暂时无法生成文档预览，可以下载原文件。"
            raise HTTPException(status if status in (400, 413, 422, 429, 500, 502, 503, 504) else 500, message)
        if len(output) > 64 * 1024 * 1024 or not output.startswith(b"%PDF-"):
            raise HTTPException(502, "生成的文档预览无效，可以下载原文件。")
        return Response(output, media_type="application/pdf", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    return FileResponse(file, media_type="application/octet-stream")


@router.put("/files")
async def upload(request: Request, task: str, path: str):
    relative_file(path)
    if not path.startswith("uploads/") or len(path.split("/")) != 2:
        raise HTTPException(400, "上传仅限任务 uploads 目录")
    directory = task_root(task)
    (directory / "uploads").mkdir(exist_ok=True)
    destination = target(task, path)
    temporary = directory / "uploads" / (".agent-lab-upload-" + secrets.token_hex(16))
    reserved = False
    size = 0
    try:
        # Exclusive reservation prevents overwriting a previous upload.
        with open(destination, "xb"):
            reserved = True
        with open(temporary, "xb") as stream:
            async for chunk in request.stream():
                size += len(chunk)
                if size > 20 * 1024 * 1024:
                    raise HTTPException(413, "单个文件最多 20 MB")
                await asyncio.to_thread(stream.write, chunk)
        os.replace(temporary, destination)
    except FileExistsError:
        temporary.unlink(missing_ok=True)
        if reserved:
            destination.unlink(missing_ok=True)
        raise HTTPException(409, "同名文件已存在，未覆盖")
    except BaseException:
        temporary.unlink(missing_ok=True)
        if reserved:
            destination.unlink(missing_ok=True)
        raise
    return {"path": path, "name": destination.name, "size": size, "directory": False, "absolutePath": str(destination)}


@router.post("/observer")
async def observer(request: Request):
    # Each task has its own native browser AND display. A view switch must
    # never select a process-wide/shared framebuffer from another task.
    task = identity((await request.json()).get("task", ""))
    service = await get_conversation_service(request).get_event_service(UUID(task))
    if service is None:
        raise HTTPException(404, "任务不存在或已删除")
    conversation = service.get_conversation()
    from openhands.tools.browser_use.definition import BrowserListTabsAction
    try:
        # Public native API also handles lazy tool/plugin initialization and
        # locking before the first agent turn. Do not reach into tools_map.
        browser = task_browser(task)
        if browser is None:
            observation = await asyncio.to_thread(conversation.execute_tool, "browser_list_tabs", BrowserListTabsAction())
            if observation.is_error:
                raise RuntimeError("原生浏览器启动失败")
            browser = task_browser(task)
        if browser is None:
            raise RuntimeError("任务浏览器未就绪")
        port = await asyncio.to_thread(browser.observer_port)
    except (KeyError, NotImplementedError):
        raise HTTPException(503, "此任务没有可用的原生浏览器工具，请新建任务后重试")
    except RuntimeError:
        raise HTTPException(503, "此任务的浏览器暂不可用，请重新连接；对话和文件保留") from None
    now = time.time()
    for token, (expiry, _, _) in list(tickets.items()):
        if expiry <= now:
            del tickets[token]
    if len(tickets) >= 16:
        raise HTTPException(429, "观察连接过多，请关闭旧窗口后重试")
    token = secrets.token_urlsafe(32)
    tickets[token] = (now + 60, browser, port)
    return {"wsPath": "/agent-lab/observe?ticket=" + token, "expiresAt": int((now + 60) * 1000), "control": False}


@app.websocket("/agent-lab/observe")
async def observe(socket: WebSocket):
    # One-use grant minted by an authenticated HTTP request. RFB is loopback
    # only, and x11vnc itself rejects keyboard/mouse input in -viewonly mode.
    grant = tickets.pop(socket.query_params.get("ticket", ""), None)
    if grant is None or grant[0] <= time.time() or grant[1].closed or not grant[1].display.alive() or grant[1].display.port != grant[2]:
        await socket.close(code=4401)
        return
    await socket.accept(subprotocol="binary" if "binary" in socket.headers.get("sec-websocket-protocol", "") else None)
    writer = None
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", grant[2])
        async def outbound():
            while chunk := await reader.read(65536):
                await socket.send_bytes(chunk)
        async def inbound():
            while True:
                chunk = await socket.receive_bytes()
                if len(chunk) > 1024 * 1024:
                    raise ValueError("观察帧过大")
                writer.write(chunk)
                await writer.drain()
        jobs = [asyncio.create_task(outbound()), asyncio.create_task(inbound())]
        try:
            await asyncio.wait(jobs, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for job in jobs:
                job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
    except Exception:
        with contextlib.suppress(Exception):
            await socket.close(code=1011)
    finally:
        if writer:
            writer.close()
            await writer.wait_closed()


app.include_router(router)

if __name__ == "__main__":
    import uvicorn
    try:
        os.environ["OH_INTERNAL_SERVER_URL"] = "http://127.0.0.1:8000"
        uvicorn.run(app, host="0.0.0.0", port=8000)
    finally:
        close_task_browsers()

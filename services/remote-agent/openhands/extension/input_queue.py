"""Persistent server outbox. The SDK still owns every model/tool/approval step."""
import asyncio
import hashlib
import json
import sqlite3
import time
from pathlib import Path
from uuid import UUID, uuid4

HELD_ERROR = "消息尚未提交，待发内容已保留。点击继续后重试。"
CONTINUE = "继续当前任务；先核对已有进度与产物，不要重复已完成的操作。\n\n"


class InputStopped(Exception):
    pass


class NativeInput:
    def __init__(self, service):
        self.service = service

    def status(self):
        # A scalar observation only; native mutation still takes the state lock.
        value = self.service.get_conversation().state.execution_status.value
        return {"finished": "completed", "waiting_for_confirmation": "waiting", "stuck": "error"}.get(value, value)

    def receipt(self, key):
        from openhands.sdk.event import MessageEvent
        marker = "selfme-input:" + key
        return any(isinstance(event, MessageEvent) and event.source == "user" and event.sender == marker for event in reversed(self.service.get_conversation().state.events))

    async def stop(self):
        await self.service.interrupt()
        # Native interrupt deliberately leaves a waiting confirmation alone.
        # Stopping a Lab turn withdraws that unapproved action, never allows it.
        conversation = self.service.get_conversation()
        def withdraw():
            from openhands.sdk.conversation.state import ConversationExecutionStatus as Status
            with conversation.state:
                if conversation.state.execution_status == Status.WAITING_FOR_CONFIRMATION:
                    conversation.reject_pending_actions("已停止当前执行，未授权操作已取消")
        await asyncio.to_thread(withdraw)
        if self.status() == "idle":
            await self.service.pause()

    async def send(self, body, key, steer, current):
        from openhands.sdk.llm import Message, TextContent
        from openhands.sdk.conversation.state import ConversationExecutionStatus as Status
        from openhands.sdk.conversation.state import ConversationState
        conversation = self.service.get_conversation()

        def append():
            with conversation.state:
                if not current():
                    raise InputStopped()
                if not steer and conversation.state.execution_status in (Status.RUNNING, Status.WAITING_FOR_CONFIRMATION):
                    return False
                # run() can implicitly execute outstanding actions. New text
                # supersedes those actions; it is never a user's approval.
                if conversation.state.execution_status != Status.RUNNING and ConversationState.get_unmatched_actions(conversation.state.active_branch()):
                    conversation.reject_pending_actions("已收到新的要求，原审批操作不再执行")
                if self.receipt(key):
                    return True
                conversation.send_message(Message(role="user", content=[TextContent(text=body)]), sender="selfme-input:" + key)
                return True

        await self.service.stop_goal_loop()
        if not await asyncio.to_thread(append):
            return False
        if not current():
            return True  # Input is already durable; Stop owns subsequent execution.
        try:
            await self.service.run()
        except ValueError as error:
            if str(error) != "conversation_already_running":
                raise
            # A run may be finishing its tail. Retry /run without appending the
            # message again; the native loop may already have consumed it.
            while current() and self.status() == "idle":
                await asyncio.sleep(0.1)
                try:
                    await self.service.run()
                    break
                except ValueError as retry:
                    if str(retry) != "conversation_already_running":
                        raise
        return True


class InputQueues:
    def __init__(self, path):
        directory = Path(path).parent
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if Path(path).exists() and (Path(path).is_symlink() or not Path(path).is_file()):
            raise ValueError("待发数据库路径无效")
        self.db = sqlite3.connect(path, isolation_level=None)
        Path(path).chmod(0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS input_tasks(task TEXT PRIMARY KEY,mode TEXT NOT NULL DEFAULT 'queue',paused INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS inputs(task TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,text TEXT NOT NULL,files TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'queued',intent TEXT NOT NULL DEFAULT 'queue',error TEXT NOT NULL DEFAULT '',PRIMARY KEY(task,id));
            CREATE TABLE IF NOT EXISTS input_dispatches(task TEXT PRIMARY KEY,id TEXT NOT NULL,ids TEXT NOT NULL,body TEXT NOT NULL,steer INTEGER NOT NULL);
            UPDATE input_tasks SET paused=1,revision=revision+1 WHERE task IN (SELECT task FROM inputs WHERE phase!='done');
        """)
        if not any(row["name"] == "deleted" for row in self.db.execute("PRAGMA table_info(input_tasks)")):
            self.db.execute("ALTER TABLE input_tasks ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
        self.drivers = {}
        self.jobs = {}
        self.generations = {}
        self.closed = False

    def bind(self, task, service):
        self.drivers[task] = NativeInput(service)

    def ensure(self, task):
        self.db.execute("INSERT OR IGNORE INTO input_tasks(task) VALUES(?)", (task,))
        if self.db.execute("SELECT deleted FROM input_tasks WHERE task=?", (task,)).fetchone()["deleted"]:
            raise ValueError("任务已删除，请新建任务")

    def bump(self, task):
        self.db.execute("UPDATE input_tasks SET revision=revision+1 WHERE task=?", (task,))

    def rows(self, task):
        return [dict(row) for row in self.db.execute("SELECT * FROM inputs WHERE task=? AND phase!='done' ORDER BY rowid", (task,))]

    def state(self, task):
        self.ensure(task)
        profile = self.db.execute("SELECT * FROM input_tasks WHERE task=?", (task,)).fetchone()
        items = [{"id": row["id"], "text": row["text"], "files": [{"name": file["name"], "path": file["path"]} for file in json.loads(row["files"])], "at": row["at"], "state": "sending" if row["phase"] == "sending" else "queued", **({"error": row["error"]} if row["error"] else {})} for row in self.rows(task)]
        return {"mode": profile["mode"], "paused": bool(profile["paused"]), "revision": profile["revision"], "items": items}

    def mode(self, task, mode):
        if mode not in ("queue", "steer"):
            raise ValueError("发送方式无效")
        if self.state(task)["items"]:
            raise ValueError("请先处理待发消息，再切换默认发送方式")
        self.db.execute("UPDATE input_tasks SET mode=? WHERE task=?", (mode, task))
        self.bump(task)
        return self.state(task)

    def pause(self, task, error=""):
        self.ensure(task)
        self.db.execute("UPDATE input_tasks SET paused=1 WHERE task=?", (task,))
        if error:
            self.db.execute("UPDATE inputs SET error=? WHERE task=? AND phase!='done'", (error, task))
        self.bump(task)

    def send(self, task, key, text, files, mode):
        if mode not in ("queue", "steer") or str(UUID(key)) != key or not isinstance(text, str) or len(text) > 100_000 or not text.strip() and not files:
            raise ValueError("消息或发送方式无效")
        self.ensure(task)
        body = text + ("\n\n上传文件（远端路径）：\n" + "\n".join(file["absolutePath"] for file in files) if files else "")
        digest = hashlib.sha256(json.dumps({"text": text, "files": files}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        prior = self.db.execute("SELECT hash FROM inputs WHERE task=? AND id=?", (task, key)).fetchone()
        if prior:
            if prior["hash"] != digest:
                raise ValueError("消息标识已用于其他内容")
            return self.state(task)
        rows = self.rows(task)
        if len(rows) >= 20 or sum(len(row["body"]) + 2 for row in rows) + len(body) > 99_500:
            raise ValueError("待发消息已达上限（20 条或 100,000 字符），请先处理现有消息")
        intent = mode
        if not rows and not self.dispatch(task) and self.drivers[task].status() not in ("running", "waiting"):
            intent = "start"
            self.db.execute("UPDATE input_tasks SET paused=0 WHERE task=?", (task,))
        self.db.execute("INSERT INTO inputs(task,id,hash,text,files,body,at,intent) VALUES(?,?,?,?,?,?,?,?)", (task, key, digest, text, json.dumps(files, ensure_ascii=False), body, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), intent))
        self.bump(task)
        self.kick(task)
        return self.state(task)

    def dispatch(self, task):
        row = self.db.execute("SELECT * FROM input_dispatches WHERE task=?", (task,)).fetchone()
        return dict(row) if row else None

    def settle(self, task, operation):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            for key in json.loads(operation["ids"]):
                self.db.execute("UPDATE inputs SET phase='done',text='',files='[]',body='',error='' WHERE task=? AND id=?", (task, key))
            self.db.execute("DELETE FROM input_dispatches WHERE task=? AND id=?", (task, operation["id"]))
            self.bump(task)
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    async def deliver(self, task, rows, steer, prefix=""):
        operation = self.dispatch(task)
        if operation and self.drivers[task].receipt(operation["id"]) and self.drivers[task].status() != "idle":
            self.settle(task, operation)
            if not prefix:
                return
            operation = None
            rows = self.rows(task)
        if operation is None:
            operation = {"id": str(uuid4()), "ids": json.dumps([row["id"] for row in rows]), "body": prefix + "\n\n".join(row["body"] for row in rows), "steer": int(steer)}
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute("INSERT INTO input_dispatches(task,id,ids,body,steer) VALUES(?,?,?,?,?)", (task, operation["id"], operation["ids"], operation["body"], operation["steer"]))
                for row in rows:
                    self.db.execute("UPDATE inputs SET phase='sending',error='' WHERE task=? AND id=?", (task, row["id"]))
                self.bump(task)
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
        generation = self.generations.get(task, 0)
        current = lambda: not self.closed and self.generations.get(task, 0) == generation
        try:
            if await self.drivers[task].send(operation["body"], operation["id"], bool(operation["steer"]), current):
                self.settle(task, operation)
        except InputStopped:
            if self.drivers[task].receipt(operation["id"]):
                self.settle(task, operation)
            else:
                self.db.execute("UPDATE inputs SET phase='queued' WHERE task=? AND phase='sending'", (task,))
                self.db.execute("DELETE FROM input_dispatches WHERE task=?", (task,))
                self.bump(task)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.pause(task, HELD_ERROR)

    def kick(self, task):
        if self.closed or task not in self.drivers or task in self.jobs and not self.jobs[task].done():
            return
        job = asyncio.create_task(self.work(task))
        self.jobs[task] = job
        def done(completed):
            if self.jobs.get(task) is completed:
                self.jobs.pop(task, None)
            if not completed.cancelled():
                completed.exception()
        job.add_done_callback(done)

    async def work(self, task):
        while not self.closed:
            try:
                driver = self.drivers[task]
                operation = self.dispatch(task)
                if operation and driver.receipt(operation["id"]) and driver.status() != "idle":
                    self.settle(task, operation)
                rows = self.rows(task)
                if not rows and not self.dispatch(task):
                    return
                status = driver.status()
                busy = status in ("running", "waiting")
                steer = next((row for row in rows if row["intent"] == "steer" and row["phase"] == "queued"), None)
                if self.state(task)["paused"]:
                    if steer and busy and not operation:
                        await self.deliver(task, [steer], True)
                        continue
                    return
                if status in ("paused", "error") and not any(row["intent"] == "start" and row["phase"] == "queued" for row in rows):
                    self.pause(task)
                    return
                if operation:
                    if not busy:
                        await self.deliver(task, [], bool(operation["steer"]))
                elif steer and busy:
                    await self.deliver(task, [steer], True)
                elif not busy:
                    await self.deliver(task, rows, False)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.pause(task, HELD_ERROR)
                return
            await asyncio.sleep(0.2)

    async def action(self, task, key, action):
        row = next((row for row in self.rows(task) if row["id"] == key), None)
        if row is None:
            raise ValueError("待发消息已提交或已删除")
        if row["phase"] == "sending":
            raise ValueError("这条消息正在提交，不能重复操作")
        if action == "remove":
            self.db.execute("UPDATE inputs SET phase='done',text='',files='[]',body='',error='' WHERE task=? AND id=?", (task, key))
        elif action == "steer":
            if self.drivers[task].status() not in ("running", "waiting"):
                raise ValueError("当前没有可补充的工作轮次")
            self.db.execute("UPDATE inputs SET intent='steer' WHERE task=? AND id=?", (task, key))
            # Explicit Steer bypasses a held queue, without unpausing its peers.
            self.kick(task)
        else:
            raise ValueError("待发操作无效")
        self.bump(task)
        return self.state(task)

    async def control(self, task, action):
        self.ensure(task)
        driver = self.drivers[task]
        if action == "stop":
            self.pause(task)
            self.generations[task] = self.generations.get(task, 0) + 1
            await driver.stop()
        elif action == "resume":
            if driver.status() in ("running", "waiting") and not self.state(task)["paused"]:
                return self.state(task)
            self.pause(task)
            pending = self.jobs.get(task)
            if pending:
                await asyncio.gather(pending, return_exceptions=True)
            self.db.execute("UPDATE input_tasks SET paused=0 WHERE task=?", (task,))
            self.bump(task)
            if driver.status() not in ("running", "waiting"):
                await self.deliver(task, self.rows(task), False, CONTINUE)
            self.kick(task)
        else:
            raise ValueError("任务操作无效")
        return self.state(task)

    async def clear(self, task):
        prior = self.db.execute("SELECT deleted FROM input_tasks WHERE task=?", (task,)).fetchone()
        if prior and prior["deleted"]:
            return
        self.pause(task)
        self.generations[task] = self.generations.get(task, 0) + 1
        job = self.jobs.pop(task, None)
        if job:
            job.cancel()
            await asyncio.gather(job, return_exceptions=True)
        for table in ("inputs", "input_dispatches"):
            self.db.execute(f"DELETE FROM {table} WHERE task=?", (task,))
        # Task-id tombstone only: delayed requests cannot recreate deleted input.
        self.db.execute("UPDATE input_tasks SET deleted=1,paused=1,mode='queue',revision=revision+1 WHERE task=?", (task,))
        self.drivers.pop(task, None)

    async def close(self):
        self.closed = True
        for job in self.jobs.values():
            job.cancel()
        await asyncio.gather(*self.jobs.values(), return_exceptions=True)
        self.db.close()

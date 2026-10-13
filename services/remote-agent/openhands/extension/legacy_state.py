"""Adopt owned-volume data without rewriting native history or user files."""
from pathlib import Path


def migrate_directory(base: Path, previous: str, current: str):
    if base.resolve() != base:
        raise RuntimeError("服务数据根目录不能是符号链接")
    old, new = base / previous, base / current
    if new.is_symlink() or (new.exists() and not new.is_dir()):
        raise RuntimeError("服务数据目录必须是真实目录")
    if old.is_symlink():
        if not new.is_dir() or old.resolve() != new:
            raise RuntimeError("旧服务数据链接不属于当前目录")
        return
    if not old.exists():
        return
    if not old.is_dir():
        raise RuntimeError("旧服务数据目录必须是真实目录")
    if new.exists():
        raise RuntimeError("新旧服务目录同时存在，未合并或覆盖数据")
    old.rename(new)
    old.symlink_to(current, target_is_directory=True)


def migrate_owned_volume(base=Path("/workspace")):
    base.mkdir(parents=True, exist_ok=True)
    migrate_directory(base, "selfme", "agent-lab")
    migrate_directory(base, ".selfme-inputs", ".agent-lab-inputs")


def private_file(name):
    return name.startswith((".agent-lab-", ".selfme-"))


def input_senders(key):
    return ("agent-lab-input:" + key, "selfme-input:" + key)

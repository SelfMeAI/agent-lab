#!/bin/sh
# Generated for Agent Lab @VERSION@. Requires Docker only, not Node or source.
set -eu
version='@VERSION@'
release_commit='@COMMIT@'
engine=${1:-all}
case "$engine" in all|openhands|openclaw) ;; *) printf '%s\n' '用法：sh prepare-remote.sh [all|openhands|openclaw]' >&2; exit 1 ;; esac
docker_cli=$(command -v docker 2>/dev/null || true)
if [ -z "$docker_cli" ] && [ -x /Applications/Docker.app/Contents/Resources/bin/docker ]; then
  docker_cli=/Applications/Docker.app/Contents/Resources/bin/docker
fi
if [ -z "$docker_cli" ]; then
  printf '%s\n' '未找到 Docker。macOS 请安装并启动 Docker Desktop；Linux 请安装 Docker Engine。' >&2; exit 1
fi
if ! server=$("$docker_cli" info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null); then
  printf '%s\n' '无法连接 Docker。请启动服务，确认当前 context 正确且有权限访问，然后重试。' >&2; exit 1
fi
case "$server" in
  linux/amd64|linux/x86_64) platform=linux/amd64 ;;
  linux/arm64|linux/aarch64) platform=linux/arm64 ;;
  *) printf '%s\n' "不支持的 Docker 服务平台：$server；需要 Linux amd64 或 arm64 容器。" >&2; exit 1 ;;
esac
install_image() {
  item=$1; image=$2; local_tag=$3; upstream=$4
  printf '\n%s\n' "准备 $item · Agent Lab $version · $platform"
  "$docker_cli" pull --platform "$platform" "$image"
  expected="$item|$upstream|1|$release_commit|$platform"
  actual=$("$docker_cli" image inspect --format '{{index .Config.Labels "ai.agent-lab.desktop.engine"}}|{{index .Config.Labels "ai.agent-lab.desktop.source.commit"}}|{{index .Config.Labels "ai.agent-lab.desktop.integration"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Os}}/{{.Architecture}}' "$image")
  if [ "$actual" != "$expected" ]; then
    printf '%s\n' "$item 镜像来源、版本或架构不匹配，未设置应用镜像标签。" >&2; exit 1
  fi
  "$docker_cli" tag "$image" "$local_tag"
}
if [ "$engine" = all ] || [ "$engine" = openhands ]; then
  install_image openhands '@OPENHANDS_IMAGE@' '@OPENHANDS_TAG@' '@OPENHANDS_COMMIT@'
fi
if [ "$engine" = all ] || [ "$engine" = openclaw ]; then
  install_image openclaw '@OPENCLAW_IMAGE@' '@OPENCLAW_TAG@' '@OPENCLAW_COMMIT@'
fi
printf '\n%s\n' '准备办公文档预览镜像…'
"$docker_cli" pull --platform "$platform" '@DOCUMENT_PREVIEW@'
printf '\n%s\n' '镜像准备完成。进入 Agent Lab → Remote Agent Lab → 服务管理，启动服务并配置你自己的模型连接。' '未启动或删除任何容器、未修改数据卷、代理、DNS 或 Docker context。'

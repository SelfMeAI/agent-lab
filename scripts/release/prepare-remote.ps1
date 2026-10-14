# Generated for Agent Lab @VERSION@. Requires Docker only, not Node or source.
param([ValidateSet('all', 'openhands', 'openclaw')][string]$Engine = 'all')
$ErrorActionPreference = 'Stop'
$releaseVersion = '@VERSION@'
$releaseCommit = '@COMMIT@'
$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerCli = if ($dockerCommand) { $dockerCommand.Source } else { Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $dockerCli -PathType Leaf)) { throw '未找到 Docker。请安装 Docker Desktop，并切换至 Linux 容器模式。' }
function Invoke-Docker {
  param([string[]]$Arguments)
  & $dockerCli @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'Docker 操作未完成，请检查服务、网络或镜像地址后重试；未删除任何容器或数据卷。' }
}
$server = & $dockerCli info --format '{{.OSType}}/{{.Architecture}}' 2>$null
if ($LASTEXITCODE -ne 0) { throw '无法连接 Docker。请启动 Docker Desktop，确认当前 context 正确，然后重试。' }
$platform = switch ($server.Trim()) {
  'linux/amd64' { 'linux/amd64' }
  'linux/x86_64' { 'linux/amd64' }
  'linux/arm64' { 'linux/arm64' }
  'linux/aarch64' { 'linux/arm64' }
  default { throw "不支持的 Docker 服务平台：$server；需要 Linux amd64 或 arm64 容器。" }
}
function Install-Image {
  param([string]$Item, [string]$Image, [string]$LocalTag, [string]$Upstream)
  Write-Host "`n准备 $Item · Agent Lab $releaseVersion · $platform"
  Invoke-Docker -Arguments @('pull', '--platform', $platform, $Image)
  # JSON avoids the native argument-quoting differences in PowerShell 5.1/7.
  $details = (Invoke-Docker -Arguments @('image', 'inspect', $Image) | Out-String | ConvertFrom-Json)[0]
  $actual = @($details.Config.Labels.'ai.agent-lab.desktop.engine', $details.Config.Labels.'ai.agent-lab.desktop.source.commit', $details.Config.Labels.'ai.agent-lab.desktop.integration', $details.Config.Labels.'org.opencontainers.image.revision', "$($details.Os)/$($details.Architecture)") -join '|'
  if ($actual.Trim() -ne "$Item|$Upstream|1|$releaseCommit|$platform") { throw "$Item 镜像来源、版本或架构不匹配，未设置应用镜像标签。" }
  Invoke-Docker -Arguments @('tag', $Image, $LocalTag)
}
if ($Engine -eq 'all' -or $Engine -eq 'openhands') { Install-Image -Item openhands -Image '@OPENHANDS_IMAGE@' -LocalTag '@OPENHANDS_TAG@' -Upstream '@OPENHANDS_COMMIT@' }
if ($Engine -eq 'all' -or $Engine -eq 'openclaw') { Install-Image -Item openclaw -Image '@OPENCLAW_IMAGE@' -LocalTag '@OPENCLAW_TAG@' -Upstream '@OPENCLAW_COMMIT@' }
Write-Host "`n准备办公文档预览镜像…"
Invoke-Docker -Arguments @('pull', '--platform', $platform, '@DOCUMENT_PREVIEW@')
Write-Host "`n镜像准备完成。进入 Agent Lab → Remote Agent Lab → 服务管理，启动服务并配置你自己的模型连接。"
Write-Host '未启动或删除任何容器、未修改数据卷、代理、DNS 或 Docker context。'

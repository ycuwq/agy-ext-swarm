[CmdletBinding()]
param(
  [string]$Version = $(if ($env:AGY_EXT_SWARM_VERSION) { $env:AGY_EXT_SWARM_VERSION } else { 'latest' }),
  [string]$PluginsDir = $(if ($env:AGY_EXT_SWARM_PLUGINS_DIR) { $env:AGY_EXT_SWARM_PLUGINS_DIR } else { Join-Path $HOME '.gemini\config\plugins' }),
  [switch]$Workspace,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$RepoSlug = 'ycuwq/agy-ext-swarm'
$PluginDirName = 'agy-ext-swarm'

if ($Workspace) {
  $PluginsDir = Join-Path (Get-Location).Path '.agents\plugins'
}

$TargetDir = Join-Path $PluginsDir $PluginDirName

if ($Uninstall) {
  if (Test-Path -LiteralPath $TargetDir) {
    Remove-Item -LiteralPath $TargetDir -Recurse -Force
    Write-Host "Removed $TargetDir"
  } else {
    Write-Host "Nothing to remove at $TargetDir"
  }
  return
}

if ($Version -eq 'latest') {
  $ArchiveUrl = "https://github.com/$RepoSlug/releases/latest/download/agy-ext-swarm.zip"
} else {
  $Tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
  $ArchiveUrl = "https://github.com/$RepoSlug/releases/download/$Tag/agy-ext-swarm-$Tag.zip"
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-ext-swarm-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
  $ZipPath = Join-Path $TempDir 'agy-ext-swarm.zip'
  $ExtractDir = Join-Path $TempDir 'extract'
  New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null

  Write-Host "Downloading AGY Ext Swarm ($Version) from:"
  Write-Host "  $ArchiveUrl"

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ZipPath -UseBasicParsing

  Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force

  $ExtractedPlugin = Join-Path $ExtractDir $PluginDirName
  $ManifestPath = Join-Path $ExtractedPlugin 'plugin.json'
  $ServerEntry = Join-Path $ExtractedPlugin 'server\dist\index.mjs'
  $BoardHtml = Join-Path $ExtractedPlugin 'server\dist\board.html'

  if (-not (Test-Path -LiteralPath $ManifestPath) -or -not (Test-Path -LiteralPath $ServerEntry) -or -not (Test-Path -LiteralPath $BoardHtml)) {
    throw 'Downloaded archive is incomplete or invalid.'
  }

  New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null

  if (Test-Path -LiteralPath $TargetDir) {
    $Item = Get-Item -LiteralPath $TargetDir -Force
    $IsReparse = ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    $OldData = Join-Path $TargetDir '.data'
    if (-not $IsReparse -and (Test-Path -LiteralPath $OldData)) {
      Move-Item -LiteralPath $OldData -Destination (Join-Path $ExtractedPlugin '.data') -Force
    }
    Remove-Item -LiteralPath $TargetDir -Recurse -Force
  }

  Move-Item -LiteralPath $ExtractedPlugin -Destination $TargetDir -Force

  Write-Host ''
  Write-Host 'Installed AGY Ext Swarm to:'
  Write-Host "  $TargetDir"

  $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($NodeCmd) {
    $NodeVerRaw = (& node -v).Trim()
    if ($NodeVerRaw -match '^v(\d+)\.') {
      $NodeMajor = [int]$Matches[1]
      if ($NodeMajor -lt 20) {
        Write-Warning "Node.js >= 20 is required to run the MCP server (detected $NodeVerRaw)."
      }
    }
  } else {
    Write-Warning 'Node.js (>= 20) was not found in PATH. Install Node.js >= 20 before starting Antigravity.'
  }

  Write-Host ''
  Write-Host 'Next steps:'
  Write-Host '  1. Open Antigravity Desktop App -> Customizations -> Installed to verify "AGY Ext Swarm" is enabled.'
  Write-Host '  2. If upgrading while Antigravity is running, refresh "agy-ext-swarm_ext_swarm" in MCP Servers settings.'
} finally {
  if (Test-Path -LiteralPath $TempDir) {
    Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

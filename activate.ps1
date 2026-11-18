param([switch]$AddIfMissing)
$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$project = $PSScriptRoot
try {
    $taskNode = (Get-Command node.exe -ErrorAction Stop).Source
} catch {
    throw 'Node.js 22.13 or newer is required; node.exe was not found.'
}

function Get-McpServerPath {
    param([string]$Section)
    $argsMatch = [regex]::Match($Section, '(?ms)^[ \t]*args[ \t]*=[ \t]*\[(?<items>.*?)\]')
    if (-not $argsMatch.Success) { return $null }
    $paths = @()
    $stringPattern = "(?s)`"(?<dq>[^`"]+)`"|'(?<sq>[^']+)'"
    foreach ($match in [regex]::Matches($argsMatch.Groups['items'].Value, $stringPattern)) {
        $candidate = if ($match.Groups['dq'].Success) { $match.Groups['dq'].Value } else { $match.Groups['sq'].Value }
        if ($candidate -match '(?i)(^|[\\/])server\.cjs$') { $paths += $candidate }
    }
    if ($paths.Count -ne 1) { return $null }
    return $paths[0]
}

$taskConfig = Join-Path $env:USERPROFILE '.codex/config.toml'
$taskConfigExists = [IO.File]::Exists($taskConfig)
$taskText = if ($taskConfigExists) { [IO.File]::ReadAllText($taskConfig) } else { '' }

# Refuse layouts this small helper cannot rewrite exactly. Other MCP tables are
# left untouched; only [mcp_servers.gemini] is owned by this script.
$nestedPattern = '(?m)^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"gemini"|''gemini''|gemini)[ \t]*\.'
if ([regex]::IsMatch($taskText, $nestedPattern)) { throw 'Nested Gemini MCP tables are not supported by this helper; configure manually using mcp.example.toml. No changes made.' }

$sectionPattern = '(?ms)^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"gemini"|''gemini''|gemini)[ \t]*\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$).*?(?=^[ \t]*\[|\z)'
$taskMatches = [regex]::Matches($taskText, $sectionPattern)
if ($taskMatches.Count -gt 1) { throw 'Duplicate Gemini MCP tables. Configure manually using mcp.example.toml. No changes made.' }
$taskMatch = if ($taskMatches.Count -eq 1) { $taskMatches[0] } else { $null }

if (-not $taskMatch -and -not $AddIfMissing) { throw 'Gemini MCP configuration section was not found; no changes made.' }
if (-not $taskMatch -and $taskText -match '(?im)^[ \t]*[^#\r\n]*mcp_servers[^\r\n]*gemini') { throw 'Gemini configuration uses an unsupported layout. Configure it manually using mcp.example.toml. No changes made.' }
if (-not $taskMatch -and $taskText -match '(?im)^[ \t]*mcp_servers[ \t]*=') { throw 'Gemini configuration uses an inline mcp_servers layout. Configure it manually using mcp.example.toml. No changes made.' }
if (-not $taskMatch -and $taskText -match '(?im)^[ \t]*\[[ \t]*mcp_servers[ \t]*\]' -and $taskText -match '(?im)^[ \t]*gemini[ \t]*(?:=|\.)') { throw 'Gemini configuration uses a nested mcp_servers layout. Configure it manually using mcp.example.toml. No changes made.' }

if ($taskMatch) {
    $existingServer = Get-McpServerPath $taskMatch.Value
    if (-not $existingServer -or -not [IO.Path]::IsPathRooted($existingServer)) {
        throw 'Cannot verify which server the existing [mcp_servers.gemini] section uses; no changes made. Update it manually using mcp.example.toml.'
    }
    try {
        $expectedServer = [IO.Path]::GetFullPath((Join-Path $project 'server.cjs'))
        $actualServer = [IO.Path]::GetFullPath($existingServer)
    } catch {
        throw 'Cannot resolve the existing [mcp_servers.gemini] server path; no changes made. Update it manually using mcp.example.toml.'
    }
    $projectPrefix = $project.TrimEnd([char[]]@('\','/')) + [IO.Path]::DirectorySeparatorChar
    $sameServer = $actualServer.Equals($expectedServer, [StringComparison]::OrdinalIgnoreCase)
    $insideProject = $actualServer.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)
    if (-not ($sameServer -or $insideProject)) {
        throw 'Existing [mcp_servers.gemini] points to a different installation; no changes made. Update it manually using mcp.example.toml.'
    }
}

$taskBackup = Join-Path $project 'state/previous-mcp-section.toml'
$taskServer = (Join-Path $project 'server.cjs').Replace('\','/')
$taskState = (Join-Path $project 'state/desktop-v1').Replace('\','/')
# JSON strings are also valid TOML basic strings, including quotes in paths.
$taskNodeLiteral = ConvertTo-Json -InputObject $taskNode -Compress
$taskServerLiteral = ConvertTo-Json -InputObject $taskServer -Compress
$taskStateLiteral = ConvertTo-Json -InputObject $taskState -Compress
$taskSection = "[mcp_servers.gemini]`ncommand = $taskNodeLiteral`nargs = [$taskServerLiteral]`nenv = { GEMINI_WORK_STATE = $taskStateLiteral }`nstartup_timeout_sec = 10.0`ntool_timeout_sec = 1810.0`nenabled = true`n"
$taskUpdated = if ($taskMatch) {
    $taskText.Substring(0, $taskMatch.Index) + $taskSection + $taskText.Substring($taskMatch.Index + $taskMatch.Length)
} elseif ($taskText.Trim().Length -gt 0) {
    $taskText.TrimEnd() + "`n`n" + $taskSection
} else {
    $taskSection
}

$verifyScript = @'
const path = require('node:path');
const { DesktopTransport } = require('./src/desktop-transport.cjs');
const transport = new DesktopTransport({ stateDir: path.join(process.cwd(), 'state', 'desktop-v1'), autoStart: true });
transport.ensureRunning().then(async result => {
  if (!result.running) throw new Error(result.message || 'desktop bridge is not available');
  const probe = await transport.awaitReady({ timeoutMs: 20000 });
  const runtime = probe.observer && probe.observer.diagnostics && probe.observer.diagnostics.runtime;
  if (probe.readOnly !== false) throw new Error('installed desktop bridge is read-only; reinstall with Install.cmd');
  if (probe.pageReady !== true) throw new Error('Gemini page is not ready; sign in and open a chat, then retry');
  if (!runtime || runtime.nativeHook !== true) throw new Error('desktop bridge native hook is not active; fully exit and reopen Gemini, then retry');
}).catch(error => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
'@
Push-Location -LiteralPath $project
try {
    & $taskNode -e $verifyScript
} finally {
    Pop-Location
}
if ($LASTEXITCODE -ne 0) { throw 'Desktop bridge verification failed; MCP configuration unchanged.' }

if ($taskMatch) {
    [IO.Directory]::CreateDirectory((Join-Path $project 'state')) | Out-Null
    if (-not (Test-Path -LiteralPath $taskBackup)) { [IO.File]::WriteAllText($taskBackup, $taskMatch.Value) }
}

[IO.Directory]::CreateDirectory((Split-Path $taskConfig)) | Out-Null
$taskTemporary = Join-Path (Split-Path $taskConfig) ('.gemini-config-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    [IO.File]::WriteAllText($taskTemporary, $taskUpdated, [Text.UTF8Encoding]::new($false))
    if ($taskConfigExists) {
        if ([IO.File]::ReadAllText($taskConfig) -cne $taskText) { throw 'Codex configuration changed during setup. Run setup again.' }
        [IO.File]::Replace($taskTemporary, $taskConfig, [NullString]::Value)
    } else {
        [IO.File]::Move($taskTemporary, $taskConfig)
    }
} finally { if ([IO.File]::Exists($taskTemporary)) { [IO.File]::Delete($taskTemporary) } }
Write-Output 'Gemini MCP now points to this project and is enabled. Reload tools in Codex to discover it.'

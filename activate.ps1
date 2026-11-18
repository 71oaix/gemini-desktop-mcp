$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node -ErrorAction Stop).Source
Push-Location -LiteralPath $PSScriptRoot
try { & $taskNode -e "new (require('./desktop-transport.cjs').DesktopTransport)().ensureRunning().then(r=>{if(!r.running||r.probe.readOnly||!r.probe.pageReady){console.error('Desktop preflight failed');process.exitCode=1;}}).catch(e=>{console.error(e.message);process.exitCode=1;})"
} finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Desktop bridge verification failed; MCP configuration unchanged.' }
$taskConfig = Join-Path $env:USERPROFILE '.codex/config.toml'
$taskText = [IO.File]::ReadAllText($taskConfig)
if ([regex]::IsMatch($taskText, '(?m)^\s*\[mcp_servers\.gemini\.')) { throw 'Nested Gemini MCP tables are not supported by this helper; configure manually using mcp.example.toml. No changes made.' }
$taskPattern = '(?ms)^\[mcp_servers\.gemini\]\r?\n.*?(?=^\[|\z)'
$taskMatch = [regex]::Match($taskText, $taskPattern)
if (-not $taskMatch.Success) { throw 'Gemini MCP configuration section was not found; no changes made.' }
$taskBackup = Join-Path $PSScriptRoot 'state/previous-mcp-section.toml'
[IO.Directory]::CreateDirectory((Join-Path $PSScriptRoot 'state')) | Out-Null
if (-not (Test-Path -LiteralPath $taskBackup)) { [IO.File]::WriteAllText($taskBackup, $taskMatch.Value) }
$taskServer = (Join-Path $PSScriptRoot 'server.cjs').Replace('\','/')
$taskState = (Join-Path $PSScriptRoot 'state/desktop-v1').Replace('\','/')
# JSON strings are also valid TOML basic strings, including quotes in paths.
$taskNodeLiteral = ConvertTo-Json -InputObject $taskNode -Compress
$taskServerLiteral = ConvertTo-Json -InputObject $taskServer -Compress
$taskStateLiteral = ConvertTo-Json -InputObject $taskState -Compress
$taskSection = "[mcp_servers.gemini]`ncommand = $taskNodeLiteral`nargs = [$taskServerLiteral]`nenv = { GEMINI_WORK_STATE = $taskStateLiteral }`nstartup_timeout_sec = 10.0`ntool_timeout_sec = 1810.0`nenabled = true`n"
$taskUpdated = $taskText.Substring(0,$taskMatch.Index) + $taskSection + $taskText.Substring($taskMatch.Index+$taskMatch.Length)
$taskTemporary = Join-Path (Split-Path $taskConfig) ('.gemini-config-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    [IO.File]::WriteAllText($taskTemporary, $taskUpdated, [Text.UTF8Encoding]::new($false))
    [IO.File]::Replace($taskTemporary, $taskConfig, [NullString]::Value)
} finally { if ([IO.File]::Exists($taskTemporary)) { [IO.File]::Delete($taskTemporary) } }
Write-Output 'Gemini MCP now points to this project and is enabled. Reload tools in Codex to discover it.'

param([switch]$SkipCodex)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$project = Split-Path $PSScriptRoot
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set; this installer only supports the current Windows user profile.' }
$installDir = Join-Path $env:LOCALAPPDATA 'Google/Gemini/app-1.16.0'
$staging = Join-Path $project 'state/desktop-build'

function Get-RequiredCommand {
    param([string]$Name, [string]$Hint)
    try {
        $command = Get-Command $Name -ErrorAction Stop
    } catch {
        throw "未找到 $Name。$Hint"
    }
    if (-not $command.Source) { throw "未找到 $Name 的可执行路径。$Hint" }
    return $command.Source
}

function Assert-GeminiClosed {
    $running = @()
    foreach ($name in @('Gemini', 'GeminiAppLauncher')) {
        $queryErrors = @()
        $processes = @(Get-Process -Name $name -ErrorAction SilentlyContinue -ErrorVariable queryErrors)
        if ($processes.Count -gt 0) { $running += $name }
        foreach ($queryError in $queryErrors) {
            if ($queryError.FullyQualifiedErrorId -notmatch 'NoProcessFoundForGivenName') {
                throw "无法确认 $name 进程状态：$($queryError.Exception.Message)"
            }
        }
    }
    if ($running.Count -gt 0) {
        throw 'Save any draft and fully exit Gemini from its tray menu. Then run Install.cmd again.'
    }
}

function Invoke-Patch {
    param([string]$Action, [string[]]$Options = @())
    $patchArguments = @('./desktop-patch.cjs', $Action, '--install-dir', $installDir, '--json') + $Options
    try {
        $result = & $node @patchArguments
    } catch {
        throw "无法运行 desktop-patch.cjs：$($_.Exception.Message)"
    }
    if ($LASTEXITCODE -ne 0) {
        $result | ForEach-Object { Write-Host $_ }
        throw "Gemini patch step failed: $Action."
    }
    $text = ($result -join "`n")
    try {
        return ($text | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        throw "Gemini patch step returned invalid JSON: $Action."
    }
}

$node = Get-RequiredCommand 'node.exe' 'Install Node.js 22.13 or newer and run Install.cmd again.'
$npm = Get-RequiredCommand 'npm.cmd' 'Install Node.js 22.13 or newer (including npm) and run Install.cmd again.'

Push-Location -LiteralPath $project
try {
    Write-Host 'Gemini Desktop MCP setup'
    Write-Host 'Checking Node.js and the fixed Gemini 1.16.0 installation...'
    & $node -e "const [major,minor]=process.versions.node.split('.').map(Number); if(major<22||(major===22&&minor<13)){console.error('Node.js '+process.versions.node+' is too old');process.exitCode=1;}"
    if ($LASTEXITCODE -ne 0) { throw 'Install Node.js 22.13 or newer and run Install.cmd again.' }
    if (-not (Test-Path -LiteralPath (Join-Path $installDir 'Gemini.exe') -PathType Leaf)) {
        throw "A matching Gemini 1.16.0 client is required at $installDir. See README.md."
    }

    Write-Host 'Installing project dependencies...'
    & $npm ci --include=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

    Write-Host 'Checking Gemini version and installation files...'
    $current = Invoke-Patch -Action 'check'
    if ($current.status -eq 'original') {
        Assert-GeminiClosed
        Write-Host 'Building the bridge from your local Gemini installation...'
        $null = Invoke-Patch -Action 'build' -Options @('--staging', $staging, '--writable')
        Assert-GeminiClosed
        Write-Host 'Installing the bridge and recording the rollback backup...'
        $null = Invoke-Patch -Action 'install' -Options @('--staging', $staging, '--yes', '--assert-closed')
        $installed = Invoke-Patch -Action 'check'
        if ($installed.status -ne 'patched') { throw 'The installed bridge did not verify as patched. See README.md.' }
    } elseif ($current.status -eq 'patched') {
        $manifestPath = Join-Path $project 'state/desktop-backup/1.16.0/manifest.json'
        $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        $expectedState = [IO.Path]::GetFullPath((Join-Path $project 'state/desktop-v1'))
        if ($manifest.readOnly -ne $false -or $manifest.stateDir -ne $expectedState) {
            throw 'The existing patch is read-only or belongs to another state folder. See README.md for rollback.'
        }
        Write-Host 'The existing writable bridge verified. Reusing it.'
    } else {
        throw 'Unrecognized installation state. See README.md.'
    }

    if ($SkipCodex) {
        Write-Host 'Bridge installed. Codex configuration was skipped; use mcp.example.toml for other MCP clients.'
    } else {
        & (Join-Path $project 'activate.ps1') -AddIfMissing
        Write-Host 'Setup complete. Restart Codex to load the Gemini tools.'
    }
} finally {
    Pop-Location
}

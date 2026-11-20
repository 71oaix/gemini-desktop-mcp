$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
} catch {
    throw '缺少 .NET ZIP 组件 System.IO.Compression.FileSystem，无法生成发行包。'
}
try { Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop } catch {}

$project = Split-Path $PSScriptRoot
$packageJson = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
if (-not $version) { throw 'package.json 缺少 version，无法生成发行包。' }

# Explicit allowlist. Never copy state/, node_modules/, dist/, Gemini files or
# packaged upstream assets into the release archive.
$files = @(
    'Install.cmd',
    'scripts/install.ps1',
    'scripts/package-windows.ps1',
    'activate.ps1',
    'server.cjs',
    'client.cjs',
    'desktop-patch.cjs',
    'desktop-baseline.json',
    'mcp.example.toml',
    'request.example.json',
    'package.json',
    'package-lock.json',
    'README.md',
    'AGENTS.md',
    'ACCEPTANCE.md',
    'LICENSE',
    '.gitignore',
    'src/client.cjs',
    'src/desktop-bridge.cjs',
    'src/desktop-events.cjs',
    'src/desktop-machine.cjs',
    'src/desktop-model-policy.cjs',
    'src/desktop-observation.cjs',
    'src/desktop-observer.cjs',
    'src/desktop-page.cjs',
    'src/desktop-patch.cjs',
    'src/desktop-stream.cjs',
    'src/desktop-transport.cjs',
    'src/queue-events.cjs',
    'src/server.cjs',
    'src/store.cjs',
    'src/supervisor.cjs',
    'src/task-activity.cjs',
    'src/task-wait.cjs',
    'src/worker.cjs',
    'docs/intention/task-service-intention.md',
    'docs/specification/capabilities-and-activity.md',
    'docs/usage/installation.md',
    'docs/usage/asking-gemini.md',
    'docs/survey/gemini-web-bridge-comparison.md',
    'docs/survey/task-service-design-evidence.md',
    'tests/desktop-bridge.test.cjs',
    'tests/desktop-events.test.cjs',
    'tests/desktop-machine.test.cjs',
    'tests/desktop-model-policy.test.cjs',
    'tests/desktop-observation.test.cjs',
    'tests/desktop-observer.test.cjs',
    'tests/desktop-page.test.cjs',
    'tests/desktop-patch.test.cjs',
    'tests/desktop-stream.test.cjs',
    'tests/desktop-transport.test.cjs',
    'tests/generation-slots.test.cjs',
    'tests/interface.test.cjs',
    'tests/model-fallback.test.cjs',
    'tests/queue-events.test.cjs',
    'tests/recovery.test.cjs',
    'tests/store-lifecycle.test.cjs',
    'tests/store-startup.test.cjs',
    'tests/supervisor.test.cjs',
    'tests/task-activity.test.cjs',
    'tests/task-wait.test.cjs',
    'tests/worker-events.test.cjs'
)

$dist = Join-Path $project 'dist'
[IO.Directory]::CreateDirectory($dist) | Out-Null
$destination = Join-Path $dist "gemini-desktop-mcp-$version-windows.zip"
if (Test-Path -LiteralPath $destination -PathType Container) { throw "输出路径是目录，不是 ZIP：$destination" }
$temporary = Join-Path $dist ('.gemini-package-' + [guid]::NewGuid().ToString('N') + '.zip.tmp')

$archive = $null
$published = $false
try {
    $seen = @{}
    $archive = [IO.Compression.ZipFile]::Open($temporary, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($relative in $files) {
            $relative = $relative.Replace('\', '/')
            if ($relative.StartsWith('/') -or $relative -match '(^|/)\.\.(/|$)') { throw "非法的包内路径：$relative" }
            if ($seen.ContainsKey($relative)) { throw "重复的包内路径：$relative" }
            $seen[$relative] = $true
            $source = Get-Item -LiteralPath (Join-Path $project $relative) -ErrorAction Stop
            if ($source.PSIsContainer -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "不是常规包文件：$relative"
            }
            $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source.FullName, $relative)
        }
    } finally {
        $archive.Dispose()
        $archive = $null
    }

    $check = [IO.Compression.ZipFile]::OpenRead($temporary)
    try {
        if ($check.Entries.Count -ne $files.Count) {
            throw "ZIP 条目数量不一致：期望 $($files.Count)，实际 $($check.Entries.Count)"
        }
    } finally {
        $check.Dispose()
    }
    if ([IO.File]::Exists($destination)) {
        [IO.File]::Replace($temporary, $destination, [NullString]::Value)
    } else {
        [IO.File]::Move($temporary, $destination)
    }
    $published = $true
} finally {
    if ($archive) { $archive.Dispose() }
    if (-not $published -and [IO.File]::Exists($temporary)) {
        try { [IO.File]::Delete($temporary) } catch {}
    }
}
Write-Output $destination

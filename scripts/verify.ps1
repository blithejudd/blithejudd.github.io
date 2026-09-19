$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Get-ChildItem (Join-Path $root 'js') -Filter '*.js' | ForEach-Object {
    & node --check $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $($_.Name)" }
}
foreach ($folder in @('scripts', 'tests')) {
    Get-ChildItem (Join-Path $root $folder) -Filter '*.mjs' | ForEach-Object {
        & node --check $_.FullName
        if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $($_.Name)" }
    }
}
& node --test (Join-Path $root 'tests\unit.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed' }
& git -C $root diff --check
if ($LASTEXITCODE -ne 0) { throw 'Git whitespace check failed' }
Write-Output 'Verification passed. Run tests/browser.mjs separately for Chromium tests.'
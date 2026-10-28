<#
  vcsNode process inventory
  Run as Administrator on each target machine, paste the output back.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\ps-procinventory.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\ps-procinventory.ps1 -Keywords Tuguan,Automation
#>

param(
    [string[]]$Keywords = @(
        'generate', 'Generate', 'Tuguan', 'Automation', 'Scene', 'Dem', 'Gis',
        'cmd.exe', 'python', 'node'
    )
)

$ErrorActionPreference = 'SilentlyContinue'

Write-Host ""
Write-Host "=============================================================="
Write-Host (" Host: {0}   Time: {1}" -f $env:COMPUTERNAME, (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Host "=============================================================="

$procs = @(Get-CimInstance Win32_Process)

Write-Host ""
Write-Host "--- 1. Matched processes (CommandLine is the identity) --------"
$matched = $procs | Where-Object {
    $cl = $_.CommandLine
    ($_.Name -eq 'cmd.exe') -or ($cl -and ($Keywords | Where-Object { $cl -like "*$_*" }))
}

if (-not $matched) {
    Write-Host "  (none matched)"
}
else {
    $matched |
        Select-Object ProcessId, ParentProcessId, Name,
            @{ n = 'Started'; e = { if ($_.CreationDate) { $_.CreationDate.ToString('MM-dd HH:mm:ss') } } },
            @{ n = 'MemMB'; e = { [math]::Round($_.WorkingSetSize / 1MB, 1) } },
            @{ n = 'CmdLine'; e = {
                    if ($_.CommandLine) {
                        $c = $_.CommandLine -replace '\s+', ' '
                        if ($c.Length -gt 150) { $c.Substring(0, 150) + '...' } else { $c }
                    }
                }
            } |
        Format-Table -AutoSize -Wrap
}

Write-Host ""
Write-Host "--- 2. Listening ports ---------------------------------------"
$listeners = @(Get-NetTCPConnection -State Listen)
if (-not $listeners) {
    Write-Host "  (none, or need Administrator)"
}
else {
    $listeners |
        Select-Object LocalAddress, LocalPort, OwningProcess,
            @{ n = 'Process'; e = { (Get-Process -Id $_.OwningProcess).ProcessName } } |
        Sort-Object LocalPort |
        Format-Table -AutoSize
}

Write-Host ""
Write-Host "--- 3. cmd.exe process tree ----------------------------------"

$byParent = @{}
foreach ($p in $procs) {
    $key = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($key)) { $byParent[$key] = New-Object System.Collections.ArrayList }
    [void]$byParent[$key].Add($p)
}

$script:visited = @{}

function Show-Tree {
    param([int]$ProcessId, [int]$Depth = 1)

    if ($script:visited.ContainsKey($ProcessId)) { return }
    $script:visited[$ProcessId] = $true
    if ($Depth -gt 6) { return }

    $node = $procs | Where-Object { $_.ProcessId -eq $ProcessId } | Select-Object -First 1
    if (-not $node) { return }

    $indent = '  ' * $Depth
    $cmd = ''
    if ($node.CommandLine) {
        $c = $node.CommandLine -replace '\s+', ' '
        $cmd = if ($c.Length -gt 90) { $c.Substring(0, 90) + '...' } else { $c }
    }
    Write-Host ("{0}[{1}] {2}  {3}" -f $indent, $node.ProcessId, $node.Name, $cmd)

    foreach ($child in $byParent[[int]$node.ProcessId]) {
        Show-Tree -ProcessId $child.ProcessId -Depth ($Depth + 1)
    }
}

$cmdProcs = @($procs | Where-Object { $_.Name -eq 'cmd.exe' })
if (-not $cmdProcs) {
    Write-Host "  (no cmd.exe running)"
}
else {
    foreach ($c in $cmdProcs) {
        $parent = $procs | Where-Object { $_.ProcessId -eq $c.ParentProcessId } | Select-Object -First 1
        if (-not $parent -or $parent.Name -ne 'cmd.exe') {
            Show-Tree -ProcessId $c.ProcessId -Depth 1
        }
    }
}

Write-Host ""
Write-Host "--- 4. Summary -----------------------------------------------"
Write-Host ("  cmd.exe : {0}" -f @($procs | Where-Object { $_.Name -eq 'cmd.exe' }).Count)
Write-Host ("  python  : {0}" -f @($procs | Where-Object { $_.Name -like 'python*' }).Count)
Write-Host ("  node    : {0}" -f @($procs | Where-Object { $_.Name -like 'node*' }).Count)
Write-Host ("  listen  : {0}" -f $listeners.Count)
Write-Host ""

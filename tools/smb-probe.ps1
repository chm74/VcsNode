#Requires -Version 5.1
<#
.SYNOPSIS
    Probe SMB read access from this machine to the vcsNode shared store.

.DESCRIPTION
    Answers one question: can THIS machine read \\<Server>\<Share>\<SubDir> ?

    Checks, in order:
      1. TCP 445 reachable
      2. Share root listable
      3. Sub directory present and listable
      4. One real file readable + SHA256 + read throughput
      5. Optional write probe (off by default)
      6. Caller identity / LocalSystem warning

    Read-only by default. The write probe only runs with -TestWrite.

.PARAMETER Server
    File server IP. Use the IP, not a host name: cross-subnet name
    resolution (NetBIOS/WINS) is unreliable in this environment.

.PARAMETER Share
    Share name, default Tools.

.PARAMETER SubDir
    Sub directory reserved for vcsNode, default _vcs.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File smb-probe.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File smb-probe.ps1 -TestWrite

.NOTES
    ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI.
#>
[CmdletBinding()]
param(
    [string]$Server = '172.16.2.98',
    [string]$Share  = 'Tools',
    [string]$SubDir = '_vcs',
    [switch]$TestWrite
)

$ErrorActionPreference = 'Continue'

$shareUnc = '\\{0}\{1}' -f $Server, $Share
$subUnc   = '{0}\{1}'   -f $shareUnc, $SubDir
$failed   = 0

function Write-Result {
    param([string]$Tag, [string]$Message)
    Write-Host ('[{0}] {1}' -f $Tag, $Message)
}

function Write-Fail {
    param([string]$Message)
    $script:failed++
    Write-Result 'FAIL' $Message
}

Write-Host ''
Write-Host '=== vcsNode SMB probe ==='
Write-Host ("host    : {0}" -f $env:COMPUTERNAME)
Write-Host ("user    : {0}" -f [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
Write-Host ("target  : {0}" -f $subUnc)
Write-Host ''

# --- 0. identity sanity --------------------------------------------------
# A process running as LocalSystem accesses SMB with the MACHINE account
# (COMPUTERNAME$). That is usually rejected by the file server. This is the
# single most common reason an agent can read a share interactively but not
# once it is registered as a Windows service.
$isSystem = $false
try {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $isSystem = $id.IsSystem
} catch { }
if ($isSystem) {
    Write-Result 'WARN' 'running as LocalSystem: SMB will use the machine account, not your user'
} else {
    Write-Result 'OK'   'running as an interactive/service account'
}

# --- 1. TCP 445 ----------------------------------------------------------
try {
    $tcp = Test-NetConnection -ComputerName $Server -Port 445 -WarningAction SilentlyContinue
    if ($tcp.TcpTestSucceeded) {
        Write-Result 'OK' ("tcp 445 open, remote {0}" -f $tcp.RemoteAddress)
    } else {
        Write-Fail 'tcp 445 blocked - SMB cannot work. Check firewall/router ACL for cross-subnet access.'
    }
} catch {
    Write-Fail ("tcp 445 test error: {0}" -f $_.Exception.Message)
}

# --- 2. share root -------------------------------------------------------
$shareOk = $false
try {
    if (Test-Path -LiteralPath $shareUnc) {
        $shareOk = $true
        Write-Result 'OK' ("share reachable: {0}" -f $shareUnc)
        $all = @(Get-ChildItem -LiteralPath $shareUnc -ErrorAction SilentlyContinue)
        $top = @($all | Select-Object -First 8)
        Write-Host ("        {0} entries at share root (first {1}):" -f $all.Count, $top.Count)
        foreach ($e in $top) {
            $kind = if ($e.PSIsContainer) { 'dir ' } else { 'file' }
            Write-Host ('        {0} {1}' -f $kind, $e.Name)
        }
    } else {
        Write-Fail ("share not reachable: {0}" -f $shareUnc)
    }
} catch {
    Write-Fail ("share access error: {0}" -f $_.Exception.Message)
}

# --- 3. sub directory ----------------------------------------------------
$subOk = $false
if ($shareOk) {
    try {
        if (Test-Path -LiteralPath $subUnc) {
            $subOk = $true
            $n = (Get-ChildItem -LiteralPath $subUnc -ErrorAction SilentlyContinue | Measure-Object).Count
            Write-Result 'OK' ("sub dir present: {0} ({1} entries)" -f $subUnc, $n)
        } else {
            Write-Result 'WARN' ("sub dir does not exist yet: {0}" -f $subUnc)
        }
    } catch {
        Write-Fail ("sub dir access error: {0}" -f $_.Exception.Message)
    }
}

# --- 4. read a real file + throughput -----------------------------------
# Picks the smallest file between 64 KB and 8 MB, so the timing is
# meaningful without copying something huge over a slow link.
if ($subOk) {
    try {
        $file = Get-ChildItem -LiteralPath $subUnc -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Length -ge 65536 -and $_.Length -le 8388608 } |
                Sort-Object Length | Select-Object -First 1

        if ($null -eq $file) {
            Write-Result 'WARN' 'no 64KB-8MB file found under _vcs, throughput not measured'
        } else {
            $tmp = Join-Path $env:TEMP ('vcsprobe_' + [guid]::NewGuid().ToString('N') + '.tmp')
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            Copy-Item -LiteralPath $file.FullName -Destination $tmp -ErrorAction Stop
            $sw.Stop()

            $mb = $file.Length / 1MB
            $sec = [math]::Max($sw.Elapsed.TotalSeconds, 0.001)
            $hash = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash
            Write-Result 'OK' ("read {0} ({1:N0} bytes) in {2:N2}s = {3:N2} MB/s" -f $file.Name, $file.Length, $sw.Elapsed.TotalSeconds, ($mb / $sec))
            Write-Host ("        sha256 {0}" -f $hash)
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Fail ("read/throughput error: {0}" -f $_.Exception.Message)
    }
}

# --- 5. optional write probe -------------------------------------------
# Writes must NOT succeed from a member node. vcsNode limits writes to the
# master; if a member can write, the share ACL is too loose.
if ($TestWrite) {
    if ($subOk) {
        $probe = Join-Path $subUnc ('__write_probe_' + [guid]::NewGuid().ToString('N') + '.txt')
        try {
            Set-Content -LiteralPath $probe -Value 'vcsNode write probe' -Encoding ASCII -ErrorAction Stop
            Write-Result 'WARN' ("WRITE SUCCEEDED - share ACL is too loose for a member node: {0}" -f $probe)
            Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        } catch {
            Write-Result 'OK' 'write denied as expected (member nodes must be read-only)'
        }
    } else {
        Write-Result 'WARN' 'skipped write probe: sub dir not accessible'
    }
}

# --- 6. negotiated SMB dialect ------------------------------------------
try {
    $conn = Get-SmbConnection -ServerName $Server -ErrorAction SilentlyContinue
    if ($conn) {
        foreach ($c in $conn) {
            Write-Host ("        smb dialect {0}, share {1}, user {2}" -f $c.Dialect, $c.ShareName, $c.UserName)
        }
    }
} catch { }

Write-Host ''
if ($failed -eq 0) {
    Write-Host ("RESULT: OK - {0} can read the share" -f $env:COMPUTERNAME)
} else {
    Write-Host ("RESULT: {0} check(s) FAILED" -f $failed)
}
Write-Host ''

# Windows-only, current-user Edge GPU preference. No process termination or downloads.
# The default action is read-only. Apply saves the exact old registry value first.
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [ValidateSet('Status', 'Apply', 'Restore')]
    [string]$Action = 'Status',
    [string]$EdgePath
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Run this script on Windows, or use Windows Settings > System > Display > Graphics.'
}
if (-not $EdgePath) {
    $running = @(Get-Process -Name msedge -ErrorAction SilentlyContinue |
        ForEach-Object { try { $_.Path } catch {} } | Where-Object { $_ } | Sort-Object -Unique)
    if ($running.Count -gt 1) { throw 'Multiple Edge installations are running. Specify -EdgePath explicitly.' }
    if ($running.Count -eq 1) { $EdgePath = $running[0] }
    else {
        $candidates = @(
            [IO.Path]::Combine([Environment]::GetFolderPath('ProgramFilesX86'), 'Microsoft\Edge\Application\msedge.exe'),
            [IO.Path]::Combine([Environment]::GetFolderPath('ProgramFiles'), 'Microsoft\Edge\Application\msedge.exe'),
            [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'Microsoft\Edge\Application\msedge.exe')
        ) | Select-Object -Unique
        $installed = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
        if ($installed.Count -ne 1) { throw 'Could not identify one Edge installation. Specify -EdgePath with the full msedge.exe path.' }
        $EdgePath = $installed[0]
    }
}
$EdgePath = [IO.Path]::GetFullPath($EdgePath)
if ([IO.Path]::GetFileName($EdgePath) -ine 'msedge.exe' -or -not (Test-Path -LiteralPath $EdgePath -PathType Leaf)) {
    throw 'EdgePath must point to an installed msedge.exe file.'
}
$registryPath = 'Software\Microsoft\DirectX\UserGpuPreferences'
$registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath, $Action -ne 'Status')
try {
    $exists = $null -ne $registry -and @($registry.GetValueNames()) -contains $EdgePath
    $oldData = if ($exists) { $registry.GetValue($EdgePath, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
    $oldKind = if ($exists) { $registry.GetValueKind($EdgePath).ToString() } else { $null }
    if ($exists -and $oldKind -ne 'String') { throw 'Existing Edge preference is not REG_SZ. No change was made.' }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $id = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($EdgePath.ToLowerInvariant())))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
    $backupDir = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'WinlifeRA2', 'GpuPreferenceBackups')
    $backupFile = [IO.Path]::Combine($backupDir, $id + '.json')
    if ($Action -eq 'Status') {
        [pscustomobject]@{ EdgePath=$EdgePath; Registry='HKCU:\'+$registryPath; Exists=$exists; Value=$oldData; BackupFile=$backupFile; HasBackup=(Test-Path -LiteralPath $backupFile) }
        return
    }
    if ($Action -eq 'Restore') {
        if (-not (Test-Path -LiteralPath $backupFile -PathType Leaf)) { throw 'No backup from this script was found. Use Windows Graphics settings to change an existing preference.' }
        $backup = Get-Content -LiteralPath $backupFile -Raw | ConvertFrom-Json
        if ($backup.schemaVersion -ne 1 -or $backup.edgePath -ine $EdgePath) { throw 'Backup does not match this Edge installation.' }
        if (-not $exists -or $oldData -cne $backup.appliedValue) { throw 'Edge GPU preference changed after Apply. No restore was made; review the backup and Windows Graphics settings.' }
        if ($PSCmdlet.ShouldProcess($EdgePath, 'Restore the exact previous current-user GPU preference')) {
            if ($backup.existed) { $registry.SetValue($EdgePath, [string]$backup.value, [Microsoft.Win32.RegistryValueKind]::String) }
            else { $registry.DeleteValue($EdgePath, $false) }
            Remove-Item -LiteralPath $backupFile
            Write-Output 'Previous Edge GPU preference restored. Restart Edge after saving your work.'
        }
        return
    }
    if ($oldData -match '(?i)(^|;)\s*GpuPreference\s*=\s*2\s*(;|$)') {
        Write-Output 'Edge already requests the high-performance GPU. No change was made.'
        return
    }
    if (Test-Path -LiteralPath $backupFile) { throw 'An earlier backup exists. Review or restore it before applying another change.' }
    $tokens = @(([string]$oldData -split ';') | Where-Object { $_ -and $_ -notmatch '(?i)^\s*GpuPreference\s*=' })
    $newData = (($tokens + 'GpuPreference=2') -join ';') + ';'
    if ($PSCmdlet.ShouldProcess($EdgePath, 'Back up and set the current-user GPU preference to high performance')) {
        [IO.Directory]::CreateDirectory($backupDir) | Out-Null
        $backup = [ordered]@{schemaVersion=1;edgePath=$EdgePath;existed=$exists;kind=$oldKind;value=$oldData;appliedValue=$newData;savedAt=[DateTime]::UtcNow.ToString('o')}
        [IO.File]::WriteAllText($backupFile, ($backup | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        if (-not $registry) { $registry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath) }
        $registry.SetValue($EdgePath, $newData, [Microsoft.Win32.RegistryValueKind]::String)
        Write-Output ('High-performance preference saved for ' + $EdgePath)
        Write-Output ('Backup: ' + $backupFile)
        Write-Output 'Save your work, finish your match, and fully restart Edge manually.'
    }
} finally { if ($registry) { $registry.Dispose() } }

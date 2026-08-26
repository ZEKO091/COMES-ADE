param(
  [Parameter(Mandatory = $true)]
  [int]$RootPid,

  [int]$TimeoutSeconds = 30
)

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ComesAdeWindowHider {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr extra);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int command);

    public const int SW_HIDE = 0;
}
'@

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$rootProcess = Get-Process -Id $RootPid -ErrorAction SilentlyContinue
$earliestTerminalStart = if ($null -ne $rootProcess) {
  $rootProcess.StartTime.AddSeconds(-2)
} else {
  [DateTime]::Now.AddSeconds(-2)
}

while ([DateTime]::UtcNow -lt $deadline) {
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $descendantIds = [System.Collections.Generic.HashSet[int]]::new()
  $parents = @($RootPid)

  while ($parents.Count -gt 0) {
    $nextParents = @()
    foreach ($parent in $parents) {
      foreach ($process in $processes) {
        if ([int]$process.ParentProcessId -ne [int]$parent) {
          continue
        }

        $childPid = [int]$process.ProcessId
        if ($descendantIds.Add($childPid)) {
          $nextParents += $childPid
        }
      }
    }
    $parents = @($nextParents)
  }

  $cargoIds = @(
    $processes |
      Where-Object { $_.Name -ieq 'cargo.exe' -and $descendantIds.Contains([int]$_.ProcessId) } |
      ForEach-Object { [uint32]$_.ProcessId }
  )

  foreach ($cargoId in $cargoIds) {
    $targetPid = [uint32]$cargoId
    [ComesAdeWindowHider]::EnumWindows({
      param($hwnd, $extra)
      [uint32]$windowPid = 0
      [ComesAdeWindowHider]::GetWindowThreadProcessId($hwnd, [ref]$windowPid) | Out-Null
      if ($windowPid -eq $targetPid -and [ComesAdeWindowHider]::IsWindowVisible($hwnd)) {
        [ComesAdeWindowHider]::ShowWindow($hwnd, [ComesAdeWindowHider]::SW_HIDE) | Out-Null
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
  }

  # Windows Terminal can host the Cargo console in its own top-level window.
  # Hide only a host whose active tab is Cargo; leave unrelated user terminals
  # alone.
  $terminalHosts = @(Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne 0 -and
      $_.MainWindowTitle -match '(?i)cargo(?:\.exe)?' -and
      $_.StartTime -ge $earliestTerminalStart
    })
  foreach ($terminalHost in $terminalHosts) {
    [ComesAdeWindowHider]::ShowWindow($terminalHost.MainWindowHandle, [ComesAdeWindowHider]::SW_HIDE) | Out-Null
  }

  if ($cargoIds.Count -gt 0) {
    break
  }

  Start-Sleep -Milliseconds 200
}

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

async function getActiveWindowInfo(timeoutMs = 3000) {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$h = [WinAPI]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) {
  Write-Output '{"processName":null,"windowTitle":null}'
  exit
}
$sb = New-Object System.Text.StringBuilder 1024
[void][WinAPI]::GetWindowText($h, $sb, $sb.Capacity)
$pid = 0
[void][WinAPI]::GetWindowThreadProcessId($h, [ref]$pid)
$pname = $null
try { $pname = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch {}
$out = @{ processName = $pname; windowTitle = $sb.ToString() } | ConvertTo-Json -Compress
Write-Output $out
`;

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", script],
    {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 200,
    }
  );
  const line = String(stdout || "").trim();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

module.exports = { getActiveWindowInfo };

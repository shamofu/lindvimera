param(
  [Parameter(Mandatory = $true)]
  [int]$TargetProcessId,
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedProfile,
  [ValidateSet('jj', 'escape')]
  [string]$Sequence = 'jj'
)

$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) {
  throw 'The OS keyboard check requires an interactive Windows desktop.'
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ProbeKeyboard {
  [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
  private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint size, out uint required);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] private static extern short GetKeyState(int key);
  [DllImport("user32.dll")] private static extern uint MapVirtualKey(uint code, uint mapping);
  [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT {
    public ushort virtualKey;
    public ushort scanCode;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT {
    public int x;
    public int y;
    public uint data;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] private struct INPUTUNION {
    [FieldOffset(0)] public KEYBDINPUT keyboard;
    [FieldOffset(0)] public MOUSEINPUT mouse;
  }
  [StructLayout(LayoutKind.Sequential)] private struct INPUT {
    public uint type;
    public INPUTUNION value;
  }

  public static bool MatchesProfile(string commandLine, string expectedProfile) {
    int count;
    IntPtr arguments = CommandLineToArgvW(commandLine, out count);
    if (arguments == IntPtr.Zero) throw new InvalidOperationException("Could not inspect the target process command line.");
    try {
      for (int index = 0; index < count; index++) {
        string argument = Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments, index * IntPtr.Size));
        if (String.Equals(argument, "--user-data-dir=" + expectedProfile, StringComparison.OrdinalIgnoreCase)) return true;
      }
      return false;
    } finally {
      LocalFree(arguments);
    }
  }

  private static string DesktopName(IntPtr desktop) {
    if (desktop == IntPtr.Zero) return "unavailable";
    var value = new StringBuilder(256);
    uint required;
    return GetUserObjectInformation(desktop, 2, value, (uint)value.Capacity * 2, out required) ? value.ToString() : "unavailable";
  }

  private static string WindowDescription(IntPtr window) {
    uint processId;
    GetWindowThreadProcessId(window, out processId);
    var name = new StringBuilder(256);
    GetClassName(window, name, name.Capacity);
    return "hwnd=" + window + ",pid=" + processId + ",class=" + name;
  }

  private static string FocusDiagnostics(IntPtr target, int expectedProcessId) {
    IntPtr inputDesktop = OpenInputDesktop(0, false, 1);
    try {
      return "target[" + WindowDescription(target) + "] foreground[" + WindowDescription(GetForegroundWindow()) + "] helperSession=" + Process.GetCurrentProcess().SessionId + " targetSession=" + Process.GetProcessById(expectedProcessId).SessionId + " helperDesktop=" + DesktopName(GetThreadDesktop(GetCurrentThreadId())) + " inputDesktop=" + DesktopName(inputDesktop);
    } finally {
      if (inputDesktop != IntPtr.Zero) CloseDesktop(inputDesktop);
    }
  }

  public static uint TypeProbe(int expectedProcessId, bool escape) {
    var windows = new List<IntPtr>();
    EnumWindows((window, unused) => {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (processId == expectedProcessId && IsWindowVisible(window)) windows.Add(window);
      return true;
    }, IntPtr.Zero);
    if (windows.Count != 1) throw new InvalidOperationException("Expected exactly one visible window owned by the isolated Obsidian process; got " + windows.Count);
    var target = windows[0];
    ShowWindowAsync(target, 9);
    for (var attempt = 0; attempt < 20 && GetForegroundWindow() != target; attempt++) {
      uint unused;
      uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out unused);
      uint targetThread = GetWindowThreadProcessId(target, out unused);
      uint helperThread = GetCurrentThreadId();
      bool attachedForeground = foregroundThread != 0 && foregroundThread != helperThread && AttachThreadInput(helperThread, foregroundThread, true);
      bool attachedTarget = targetThread != helperThread && targetThread != foregroundThread && AttachThreadInput(helperThread, targetThread, true);
      try {
        BringWindowToTop(target);
        SetForegroundWindow(target);
      } finally {
        if (attachedTarget) AttachThreadInput(helperThread, targetThread, false);
        if (attachedForeground) AttachThreadInput(helperThread, foregroundThread, false);
      }
      Thread.Sleep(100);
    }
    if (GetForegroundWindow() != target) throw new InvalidOperationException("Could not focus the isolated Obsidian window. No keys were sent. " + FocusDiagnostics(target, expectedProcessId));
    foreach (var key in new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) {
      if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new InvalidOperationException("A modifier is held. No keys were sent.");
    }
    if ((GetKeyState(0x14) & 1) != 0) throw new InvalidOperationException("Caps Lock is enabled. No keys were sent.");
    var inputs = new List<INPUT>();
    var keys = new List<int> { 0x49, 0x41, 0x42, 0x43, 0x4A, 0x4A };
    if (escape) keys.Add(0x1B);
    foreach (var key in keys) {
      ushort scanCode = (ushort)MapVirtualKey((uint)key, 0);
      if (scanCode == 0) throw new InvalidOperationException("No hardware scan code for a probe key. No keys were sent.");
      inputs.Add(new INPUT { type = 1, value = new INPUTUNION { keyboard = new KEYBDINPUT { scanCode = scanCode, flags = 8 } } });
      inputs.Add(new INPUT { type = 1, value = new INPUTUNION { keyboard = new KEYBDINPUT { scanCode = scanCode, flags = 10 } } });
    }
    if (GetForegroundWindow() != target) throw new InvalidOperationException("The isolated window lost focus. No keys were sent.");
    uint sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Count) throw new InvalidOperationException("SendInput delivered " + sent + " of " + inputs.Count + " events; Win32 error " + Marshal.GetLastWin32Error());
    return sent;
  }
}
'@

$application = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId"
if (-not $application -or -not [ProbeKeyboard]::MatchesProfile($application.CommandLine, $ExpectedProfile)) {
  throw 'The target process does not use this invocation''s isolated profile. No keys were sent.'
}
$ancestor = $application
for ($depth = 0; $depth -lt 20 -and $ancestor -and $ancestor.ProcessId -ne $RootProcessId; $depth++) {
  $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)"
}
if (-not $ancestor -or $ancestor.ProcessId -ne $RootProcessId) {
  throw 'The target process does not belong to the application launched by this invocation. No keys were sent.'
}
$eventsSent = [ProbeKeyboard]::TypeProbe($TargetProcessId, $Sequence -eq 'escape')
@{
  method = 'win32-send-input'
  processId = $TargetProcessId
  eventsSent = $eventsSent
  sequence = $Sequence
  foregroundVerified = $true
  isolatedProfileVerified = $true
  processTreeVerified = $true
} | ConvertTo-Json -Compress

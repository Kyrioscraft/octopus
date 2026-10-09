import { spawn } from "node:child_process";
import { getLogger } from "@octopus/core";

// =============================================================================
// Native directory picker — the OS "choose a folder" dialog, hosted by the
// server process.
//
// The web UI runs in a browser, which cannot read absolute host paths (security
// model), so the in-app DirBrowserModal had to render a server-driven tree.
// The server, however, is a plain local process (127.0.0.1) and CAN open the
// real OS dialog — the same IFileDialog Electron apps show. This module shells
// out per platform and returns the picked absolute path.
//
// No new dependency: Windows uses PowerShell + Windows Forms, macOS uses
// osascript, Linux prefers zenity then kdialog.
// =============================================================================

const logger = getLogger("workspace.directory-picker");

/** Raised when the dialog cannot be shown at all (missing helper binary,
 *  headless session, script error). Distinct from a user cancel. */
export class PickerUnavailableError extends Error {}

/** Raised when the user closes the dialog without choosing. */
export class PickerCancelledError extends Error {}

interface SpawnResult {
  code: number;
  stdout: string;
}

/** Buffer a child process to completion with a hard timeout. */
function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new PickerUnavailableError(`directory picker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PickerUnavailableError(`${cmd} 无法启动：${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

// Modern Vista-style IFileDialog (the same dialog Electron/VS Code show):
// address bar, Quick Access, paste-a-path. PowerShell COM interop via
// Add-Type'd C# — no external dependency. FOS_PICKFOLDERS makes it a folder
// picker; TopMost owner keeps the dialog above browser windows.
const WIN_PS_SCRIPT = `
$code = @'
using System;
using System.Runtime.InteropServices;

public class FolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialog { }

  [DllImport("user32.dll")]
  static extern IntPtr GetActiveWindow();

  [DllImport("user32.dll")]
  static extern IntPtr GetConsoleWindow();

  [Flags]
  enum FOS : uint {
    PICKFOLDERS = 0x20,
    FORCEFILESYSTEM = 0x40
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct COMDLG_FILTERSPEC {
    public string pszName;
    public string pszSpec;
  }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    // --- IModalWindow ---
    [PreserveSig] int Show(IntPtr hwndOwner);
    // --- IFileDialog ---
    [PreserveSig] int SetFileTypes(uint cFileTypes, COMDLG_FILTERSPEC[] rgFilterSpec);
    [PreserveSig] int SetFileTypeIndex(uint iFileType);
    [PreserveSig] int GetFileTypeIndex(out uint piFileType);
    [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
    [PreserveSig] int Unadvise(uint dwCookie);
    [PreserveSig] int SetOptions(uint options);
    [PreserveSig] int GetOptions(out uint options);
    [PreserveSig] int SetDefaultFolder(IShellItem psi);
    [PreserveSig] int SetFolder(IShellItem psi);
    [PreserveSig] int GetFolder(out IShellItem ppsi);
    [PreserveSig] int GetCurrentSelection(out IShellItem ppsi);
    [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    [PreserveSig] int GetResult(out IShellItem ppsi);
    [PreserveSig] int AddPlace(IShellItem psi, uint fdap);
    [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    [PreserveSig] int Close(int hr);
    [PreserveSig] int SetClientGuid(ref Guid guid);
    [PreserveSig] int ClearClientData();
    [PreserveSig] int SetFilter(IntPtr pFilter);
    // --- IFileOpenDialog ---
    [PreserveSig] int GetResults(out IntPtr ppenum);
    [PreserveSig] int GetSelectedItems(out IntPtr ppsai);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetParent();
    [PreserveSig] int GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
  }

  public static string Pick(string title, out int hr) {
    var dialog = (IFileOpenDialog)(object)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | (uint)(FOS.PICKFOLDERS | FOS.FORCEFILESYSTEM));
    dialog.SetTitle(title);
    // Owner IntPtr.Zero: the dialog runs its own top-level message loop and
    // takes foreground focus itself. Nudging a foreign window to foreground
    // first steals the FIRST user click (it only refocuses the owner), which
    // read as "the right pane doesn't respond". The dialog activates itself.
    hr = dialog.Show(IntPtr.Zero);
    if (hr != 0) return null;  // cancelled (HRESULT_FROM_WIN32(ERROR_CANCELLED))
    IShellItem item;
    dialog.GetResult(out item);
    string path;
    item.GetDisplayName(0x80058000, out path);  // SIGDN_FILESYSPATH
    return path;
  }
}
'@
Add-Type -TypeDefinition $code
$hr = 0
$r = [FolderPicker]::Pick('选择工作区目录', [ref]$hr)
if ($r) { Write-Output $r } else { Write-Output ("CANCELLED hr=0x" + $hr.ToString("X")) }`;

const MAC_APPLESCRIPT = `
tell application "System Events" to activate
set picked to choose folder with prompt "选择工作区目录"
POSIX path of picked`;

/** Open the platform folder dialog and resolve the picked absolute path.
 *  `root` is unused on Windows (IFileDialog starts at the last visited folder,
 *  like every native app) and as zenity/kdialog's start dir on Linux. */
export async function pickHostDirectory(root?: string): Promise<string> {
  const platform = process.platform;
  let result: SpawnResult;
  try {
    if (platform === "win32") {
      result = await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-Command", WIN_PS_SCRIPT],
        5 * 60_000,
      );
    } else if (platform === "darwin") {
      result = await run("osascript", ["-e", MAC_APPLESCRIPT], 5 * 60_000);
    } else {
      // Linux: zenity first, kdialog fallback. Exit code 1 = user cancel for both.
      try {
        result = await run("zenity", ["--file-selection", "--directory", "--title", "选择工作区目录"], 5 * 60_000);
      } catch {
        result = await run("kdialog", ["--getexistingdirectory", root ?? process.env["HOME"] ?? "/", "--title", "选择工作区目录"], 5 * 60_000);
      }
    }
  } catch (err) {
    if (err instanceof PickerUnavailableError) throw err;
    throw new PickerUnavailableError((err as Error).message);
  }

  const picked = result.stdout.trim();
  // Windows Forms: OK returns 0 with the path on stdout. zenity/kdialog: 1 =
  // cancel (empty stdout). osascript: cancel exits non-zero with stderr noise.
  if (result.code !== 0 || !picked) {
    logger.info("Native directory picker closed without a selection", { code: result.code });
    throw new PickerCancelledError();
  }
  logger.info("Native directory picker returned a path");
  return picked;
}

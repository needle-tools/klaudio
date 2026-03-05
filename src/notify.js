import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Send a native OS notification (fire-and-forget).
 * Click-to-focus: activates the terminal or editor that triggered it.
 *
 * Windows: WinRT toast (Win10+), focuses Windows Terminal or VS Code on click
 * macOS:   terminal-notifier (if installed) or osascript fallback
 * Linux:   notify-send
 */
export function sendNotification(title, body) {
  const os = platform();
  try {
    if (os === "win32") return notifyWindows(title, body);
    if (os === "darwin") return notifyMac(title, body);
    return notifyLinux(title, body);
  } catch {
    return Promise.resolve();
  }
}

/**
 * Detect the terminal/editor environment.
 */
function detectTerminal() {
  const tp = process.env.TERM_PROGRAM;
  if (tp === "vscode") return "vscode";
  if (tp === "cursor") return "cursor";
  if (tp === "iTerm.app") return "iterm";
  if (tp === "Apple_Terminal") return "terminal";
  if (process.env.WT_SESSION) return "windows-terminal";
  // Fallback: check PATH for clues (hooks inherit the terminal's env)
  const path = process.env.PATH || "";
  if (/cursor[/\\]/i.test(path) && /resources[/\\]app[/\\]bin/i.test(path)) return "cursor";
  if (/VS Code[/\\]bin/i.test(path) || /Code[/\\]bin/i.test(path)) return "vscode";
  return "unknown";
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ── Windows ──────────────────────────────────────────────────────

function notifyWindows(title, body) {
  const safeTitle = escapeXml(title);
  const safeBody = escapeXml(body);

  // Determine activation strategy based on the terminal we're running in
  let toastAttrs = "";
  let appId;
  const terminal = detectTerminal();

  // Windows requires a registered AUMID for toasts to actually show.
  // Use Windows Terminal's AUMID as default (works on most Win10+ systems).
  // For VS Code/Cursor, also add protocol activation so clicking focuses the editor.
  appId = "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App";

  if (terminal === "vscode" || terminal === "cursor") {
    const protocol = terminal === "cursor" ? "cursor://" : "vscode://";
    toastAttrs = ` activationType="protocol" launch="${protocol}"`;
  }

  const toastXml = `<toast${toastAttrs}><visual><binding template="ToastGeneric"><text>${safeTitle}</text><text>${safeBody}</text></binding></visual></toast>`;

  // PowerShell script: show WinRT toast notification
  // Use -EncodedCommand to avoid all escaping issues with special chars
  const ps = `\
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
$x = [Windows.Data.Xml.Dom.XmlDocument]::new()
$x.LoadXml('${toastXml.replace(/'/g, "''")}')
$t = [Windows.UI.Notifications.ToastNotification]::new($x)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($t)`;

  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return Promise.resolve();
}

// ── macOS ────────────────────────────────────────────────────────

function notifyMac(title, body) {
  try {
    // Determine which app to activate when the notification is clicked
    const terminal = detectTerminal();
    const bundleIds = {
      vscode: "com.microsoft.VSCode",
      cursor: "com.todesktop.230313mzl4w4u92",
      iterm: "com.googlecode.iterm2",
      terminal: "com.apple.Terminal",
    };
    const bundleId = bundleIds[terminal] || "com.apple.Terminal";

    // Try terminal-notifier first (best UX: click-to-focus), fall back to osascript
    return new Promise((resolve) => {
      const child = spawn("terminal-notifier", [
        "-title", title, "-message", body,
        "-activate", bundleId, "-sender", bundleId,
      ], { stdio: "ignore" });

      child.on("error", () => {
        // terminal-notifier not installed — fall back to osascript
        try {
          const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const safeBody = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const script = `display notification "${safeBody}" with title "${safeTitle}"`;
          const child2 = spawn("osascript", ["-e", script], {
            stdio: "ignore",
            detached: true,
          });
          child2.unref();
        } catch { /* ignore */ }
        resolve();
      });

      child.on("close", () => resolve());
    });
  } catch {
    return Promise.resolve();
  }
}

// ── Linux ────────────────────────────────────────────────────────

function notifyLinux(title, body) {
  const child = spawn("notify-send", ["-a", "klaudio", title, body], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return Promise.resolve();
}

import { spawn } from "node:child_process";

export async function notify(title: string, message: string): Promise<void> {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      await run("osascript", ["-e", `display notification ${quoteAppleScript(message)} with title ${quoteAppleScript(title)}`]);
    } else if (platform === "win32") {
      await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; ` +
          `Write-Host ${JSON.stringify(`${title}: ${message}`)}`
      ]);
    } else {
      await run("notify-send", [title, message]);
    }
  } catch {
    // Notifications are best-effort and must not fail the supervisor.
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

function quoteAppleScript(value: string): string {
  return JSON.stringify(value);
}

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { CommandSpec } from "./command.ts";

/**
 * The platform's "hand this to whatever handles it" command.
 *
 * Provisional in the same way the hub start command is: a packaged desktop
 * shell would raise its own window here instead, and `CO_CANVAS_OPEN_CMD`
 * exists so nobody has to wait for that.
 */
export function platformOpenCommand(platform: NodeJS.Platform = process.platform): CommandSpec {
  if (platform === "darwin") return { executable: "open", args: [] };
  // `start` is a `cmd.exe` builtin whose first quoted argument is the window
  // title. Without the empty one it swallows the URL and opens a console.
  if (platform === "win32") return { executable: "cmd", args: ["/c", "start", ""] };
  return { executable: "xdg-open", args: [] };
}

/**
 * Launches `command` on `url`, reporting whether a process actually started.
 *
 * A host with no browser — every server this is likely to run on — is the
 * normal case rather than a failure, so this answers `false` instead of
 * throwing. What it cannot report is whether a browser eventually appeared:
 * `xdg-open` exits long before that, and waiting for it would block the tool
 * call on a human.
 */
export async function openInBrowser(command: CommandSpec, url: string): Promise<boolean> {
  let child: ChildProcess;
  try {
    child = spawn(command.executable, [...command.args, url], {
      // Never a shell: the URL is data from outside this process, and a shell
      // would make it an injection surface.
      shell: false,
      // `xdg-open` writes to stdout, and this process's stdout is the MCP
      // stream. Detached and ignored, a browser also outlives the bridge.
      detached: true,
      stdio: "ignore",
    });
  } catch {
    // `spawn` throws rather than emitting for arguments it rejects out of hand,
    // an empty executable being the likely one when the override is set blank.
    return false;
  }

  const started = await new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  // Unreffed only once the outcome is known: until then the handle is the only
  // thing that can tell us the command did not exist.
  child.unref();
  return started;
}

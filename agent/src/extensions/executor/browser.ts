import { spawn } from "node:child_process";

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

function resolveBrowserLaunch(target: string):
  | {
      command: string;
      args: string[];
      options: { stdio: "ignore" };
    }
  | {
      command: string;
      args: string[];
      options: { stdio: "ignore"; detached: true };
    } {
  if (process.platform === "darwin") {
    return {
      command: "open",
      args: [target],
      options: { stdio: "ignore" },
    };
  }

  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Start '${escapePowerShell(target)}'`,
      ],
      options: { stdio: "ignore" },
    };
  }

  return {
    command: "xdg-open",
    args: [target],
    options: { stdio: "ignore", detached: true },
  };
}

export async function openBrowserTarget(target: string): Promise<void> {
  const launch = resolveBrowserLaunch(target);

  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(launch.command, launch.args, launch.options);

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
}

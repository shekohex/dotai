import { spawn } from "node:child_process";

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

export async function openBrowserTarget(target: string): Promise<void> {
  const platform = process.platform;

  const launch =
    platform === "darwin"
      ? {
          command: "open",
          args: [target],
          options: { stdio: "ignore" as const },
        }
      : platform === "win32"
        ? {
            command: "powershell",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              `Start '${escapePowerShell(target)}'`,
            ],
            options: { stdio: "ignore" as const },
          }
        : {
            command: "xdg-open",
            args: [target],
            options: { stdio: "ignore" as const, detached: true },
          };

  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(launch.command, launch.args, launch.options);

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
}

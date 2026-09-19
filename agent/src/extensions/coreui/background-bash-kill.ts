import { writeFile } from "node:fs/promises";

import type { BackgroundShellRun } from "./background-bash-types.js";

// tmux/herdr kills destroy the pane before the run script can write its exit
// file, so backends must synthesize it to funnel the kill through the normal
// completion notification path. 143 = SIGTERM, classified as "killed".
// Flag "wx" fails with EEXIST if the script wrote a real exit code in a
// kill/natural-exit race; the real code must win.
export async function writeKilledExitFile(
  run: Pick<BackgroundShellRun, "exitFile">,
): Promise<void> {
  await writeFile(run.exitFile, "143\n", { flag: "wx" }).catch(() => {});
}

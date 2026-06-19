import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { FallbackMuxAdapter } from "./fallback-mux.js";
import { HerdrAdapter } from "./herdr.js";
import type { MuxAdapter } from "./mux.js";
import { PtyAdapter } from "./pty.js";
import { TmuxAdapter } from "./tmux.js";

export function createDefaultMuxAdapter(pi: ExtensionAPI): MuxAdapter {
  return new FallbackMuxAdapter([
    new HerdrAdapter(
      (command, args, execOptions) => pi.exec(command, args, execOptions),
      process.cwd(),
    ),
    new TmuxAdapter(
      (command, args, execOptions) => pi.exec(command, args, execOptions),
      process.cwd(),
    ),
    new PtyAdapter(),
  ]);
}

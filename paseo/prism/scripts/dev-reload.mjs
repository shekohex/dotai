// Reloads the plugin whenever its source changes. Run with `npm run dev`.
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const WATCHED = ["client", "server", "shared", "index.client.tsx", "index.server.ts", "paseo-plugin.json"];
const DEBOUNCE_MS = 400;

let timer;
let running = false;
let queued = false;

function reload() {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  const child = spawn("paseo", ["plugin", "reload", "prism"], { stdio: "inherit" });
  child.on("exit", (code) => {
    console.log(`[prism] reload ${code === 0 ? "ok" : `failed (${code})`}`);
    running = false;
    if (queued) {
      queued = false;
      reload();
    }
  });
}

for (const entry of WATCHED) {
  watch(`${root}${entry}`, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(reload, DEBOUNCE_MS);
  });
}
console.log("[prism] watching for changes");

#!/usr/bin/env node
import { ensureDependencyPatches } from "../scripts/postinstall.mjs";
await ensureDependencyPatches();
await import("../dist/cli.js");

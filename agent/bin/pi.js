#!/usr/bin/env node
import { ensureDependencyPatches } from "../scripts/postinstall.mjs";
ensureDependencyPatches();
await import("../dist/cli.js");

import type { UsageProvider } from "../types.js";
import { codexUsageProvider } from "./codex.js";
import { zaiUsageProvider } from "./zai.js";

export const usageProviders: UsageProvider[] = [codexUsageProvider, zaiUsageProvider];

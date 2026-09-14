#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});

async function main() {
  const providerId = process.argv[2];
  if (providerId === undefined || !/^[A-Za-z0-9._-]+$/.test(providerId)) {
    throw new Error("Usage: node pi-agent-auth.mjs <provider-id>");
  }

  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  let contents;
  try {
    contents = await readFile(authPath, "utf8");
  } catch {
    throw new Error(`Pi auth file not found or unreadable: ${authPath}. Configure ${providerId} in Pi.`);
  }

  let auth;
  try {
    auth = JSON.parse(contents);
  } catch {
    throw new Error(`Pi auth file contains invalid JSON: ${authPath}.`);
  }

  if (!isRecord(auth) || !Object.hasOwn(auth, providerId)) {
    throw new Error(`Pi auth has no key for provider ${providerId}: ${authPath}.`);
  }

  const providerAuth = auth[providerId];
  if (!isRecord(providerAuth) || typeof providerAuth.key !== "string") {
    throw new Error(`Pi auth has no key for provider ${providerId}: ${authPath}.`);
  }

  const key = providerAuth.key.trim();
  if (key.length === 0 || key === "null") {
    throw new Error(`Pi auth has no key for provider ${providerId}: ${authPath}.`);
  }

  process.stdout.write(`${key}\n`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

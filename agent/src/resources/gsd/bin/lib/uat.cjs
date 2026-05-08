/**
 * UAT Audit — Cross-phase UAT/VERIFICATION scanner
 *
 * Reads all *-UAT.md and *-VERIFICATION.md files across all phases. Extracts non-passing items.
 * Returns structured JSON for workflow consumption.
 */

const fs = require("fs");
const path = require("path");
const { output, error, getMilestonePhaseFilter, toPosixPath } = require("./core.cjs");
const { planningDir } = require("./planning-workspace.cjs");
const { extractFrontmatter } = require("./frontmatter.cjs");
const { requireSafePath, sanitizeForDisplay } = require("./security.cjs");

function parseHumanVerificationFrontmatter(content) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!frontmatterMatch) {
    return [];
  }
  const yaml = frontmatterMatch[1];
  const yamlLines = yaml.split(/\r?\n/);
  const startIndex = yamlLines.findIndex((line) => /^human_verification:\s*$/.test(line.trim()));
  if (startIndex === -1) {
    return [];
  }

  const lines = [];
  for (let index = startIndex + 1; index < yamlLines.length; index += 1) {
    const line = yamlLines[index];
    if (/^\S[\w-]*:\s*/.test(line) && !/^\s/.test(line)) {
      break;
    }
    lines.push(line);
  }
  const entries = [];
  let current = null;

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const itemMatch = line.match(/^\s*-\s*(.*)$/);
    if (itemMatch) {
      if (current !== null) {
        entries.push(current);
      }
      current = {};
      const inlineFieldMatch = itemMatch[1].match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
      if (inlineFieldMatch) {
        current[inlineFieldMatch[1]] = inlineFieldMatch[2].replace(/^"|"$/g, "").trim();
      }
      continue;
    }
    const fieldMatch = line.match(/^\s+([a-zA-Z0-9_-]+):\s*(.+)$/);
    if (fieldMatch && current !== null) {
      current[fieldMatch[1]] = fieldMatch[2].replace(/^"|"$/g, "").trim();
    }
  }
  if (current !== null) {
    entries.push(current);
  }
  return entries;
}

function parseTests(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sectionMatch = normalized.match(/##\s*Tests\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!sectionMatch) {
    return [];
  }

  return sectionMatch[1]
    .split(/\n(?=###\s*\d+\.\s*)/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const heading = block.match(/^###\s*(\d+)\.\s*(.+)$/m);
      const expectedBlock =
        block.match(/^expected:\s*\|\n([\s\S]*?)(?=^\w[\w-]*:\s)/m) ||
        block.match(/^expected:\s*\|\n([\s\S]+)/m);
      const expectedInline = block.match(/^expected:\s*(.+)$/m);
      const resultMatch = block.match(/^result:\s*\[?(\w+)\]?\s*$/m);
      const reasonMatch = block.match(/^reason:\s*(.+)\s*$/m);
      const blockedByMatch = block.match(/^blocked_by:\s*(.+)\s*$/m);
      if (!heading || !resultMatch || (!expectedBlock && !expectedInline)) {
        return null;
      }
      const expected = expectedBlock
        ? expectedBlock[1]
            .split("\n")
            .map((line) => line.replace(/^ {2}/, ""))
            .join("\n")
            .trim()
        : expectedInline[1].trim();
      return {
        number: Number.parseInt(heading[1], 10),
        name: heading[2].trim(),
        expected,
        result: resultMatch[1].trim(),
        reason: reasonMatch?.[1]?.trim(),
        blocked_by: blockedByMatch?.[1]?.trim(),
      };
    })
    .filter(Boolean);
}

function cmdAuditUat(cwd, raw) {
  const phasesDir = path.join(planningDir(cwd), "phases");
  if (!fs.existsSync(phasesDir)) {
    error("No phases directory found in planning directory");
  }

  const isDirInMilestone = getMilestonePhaseFilter(cwd);
  const results = [];

  // Scan all phase directories
  const dirs = fs
    .readdirSync(phasesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter(isDirInMilestone)
    .sort();

  for (const dir of dirs) {
    const phaseMatch = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)/i);
    const phaseNum = phaseMatch ? phaseMatch[1] : dir;
    const phaseDir = path.join(phasesDir, dir);
    const files = fs.readdirSync(phaseDir);

    // Process UAT files
    for (const file of files.filter(
      (f) => (f.includes("-UAT") || f === "UAT.md") && f.endsWith(".md"),
    )) {
      const content = fs.readFileSync(path.join(phaseDir, file), "utf-8");
      const items = parseUatItems(content);
      if (items.length > 0) {
        results.push({
          phase: phaseNum,
          phase_dir: dir,
          file,
          file_path: toPosixPath(path.relative(cwd, path.join(phaseDir, file))),
          type: "uat",
          status: extractFrontmatter(content).status || "unknown",
          items,
        });
      }
    }

    // Process VERIFICATION files
    for (const file of files.filter((f) => f.includes("-VERIFICATION") && f.endsWith(".md"))) {
      const content = fs.readFileSync(path.join(phaseDir, file), "utf-8");
      const status = extractFrontmatter(content).status || "unknown";
      if (status === "human_needed" || status === "gaps_found") {
        const items = parseVerificationItems(content, status);
        if (items.length > 0) {
          results.push({
            phase: phaseNum,
            phase_dir: dir,
            file,
            file_path: toPosixPath(path.relative(cwd, path.join(phaseDir, file))),
            type: "verification",
            status,
            items,
          });
        }
      }
    }
  }

  // Compute summary
  const summary = {
    total_files: results.length,
    total_items: results.reduce((sum, r) => sum + r.items.length, 0),
    by_category: {},
    by_phase: {},
  };

  for (const r of results) {
    if (!summary.by_phase[r.phase]) summary.by_phase[r.phase] = 0;
    for (const item of r.items) {
      summary.by_phase[r.phase]++;
      const cat = item.category || "unknown";
      summary.by_category[cat] = (summary.by_category[cat] || 0) + 1;
    }
  }

  output({ results, summary }, raw);
}

function cmdRenderCheckpoint(cwd, options = {}, raw) {
  const filePath = options.file;
  if (!filePath) {
    error("UAT file required: use uat render-checkpoint --file <path>");
  }

  const resolvedPath = requireSafePath(filePath, cwd, "UAT file", { allowAbsolute: true });
  if (!fs.existsSync(resolvedPath)) {
    error(`UAT file not found: ${filePath}`);
  }

  const content = fs.readFileSync(resolvedPath, "utf-8");
  rewriteCurrentTestForResume(resolvedPath, content);
  const currentTest = parseCurrentTest(fs.readFileSync(resolvedPath, "utf-8"));

  if (currentTest.complete) {
    error("UAT session is already complete; no pending checkpoint to render");
  }

  const checkpoint = buildCheckpoint(currentTest);
  output(
    {
      file_path: toPosixPath(path.relative(cwd, resolvedPath)),
      test_number: currentTest.number,
      test_name: currentTest.name,
      checkpoint,
    },
    raw,
    checkpoint,
  );
}

function parseCurrentTest(content) {
  const currentTestMatch = content.match(
    /##\s*Current Test\s*(?:\n<!--[\s\S]*?-->)?\n([\s\S]*?)(?=\n##\s|$)/i,
  );
  if (!currentTestMatch) {
    error("UAT file is missing a Current Test section");
  }

  const section = currentTestMatch[1].trimEnd();
  if (!section.trim()) {
    error("Current Test section is empty");
  }

  if (/\[testing complete\]/i.test(section)) {
    return { complete: true };
  }

  const numberMatch = section.match(/^number:\s*(\d+)\s*$/m);
  const nameMatch = section.match(/^name:\s*(.+)\s*$/m);
  const expectedBlockMatch =
    section.match(/^expected:\s*\|\n([\s\S]*?)(?=^\w[\w-]*:\s)/m) ||
    section.match(/^expected:\s*\|\n([\s\S]+)/m);
  const expectedInlineMatch = section.match(/^expected:\s*(.+)\s*$/m);

  if (!numberMatch || !nameMatch || (!expectedBlockMatch && !expectedInlineMatch)) {
    error("Current Test section is malformed");
  }

  let expected;
  if (expectedBlockMatch) {
    expected = expectedBlockMatch[1]
      .split("\n")
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n")
      .trim();
  } else {
    expected = expectedInlineMatch[1].trim();
  }

  return {
    complete: false,
    number: parseInt(numberMatch[1], 10),
    name: sanitizeForDisplay(nameMatch[1].trim()),
    expected: sanitizeForDisplay(expected),
  };
}

function rewriteCurrentTestForResume(filePath, content) {
  const currentTestMatch = content.match(
    /##\s*Current Test\s*(?:\n<!--[\s\S]*?-->)?\n([\s\S]*?)(?=\n##\s|$)/i,
  );
  if (!currentTestMatch) {
    return;
  }

  const section = currentTestMatch[1].trim();
  if (/\[testing complete\]/i.test(section)) {
    return;
  }

  const tests = parseTests(content);
  const unresolvedTest = tests.find(
    (test) =>
      test.result === "pending" ||
      test.result === "blocked" ||
      (test.result === "skipped" && (!test.reason || test.reason.trim().length === 0)),
  );
  if (!unresolvedTest) {
    error("UAT session is already complete; no pending checkpoint to render");
  }

  const currentNumberMatch = section.match(/^number:\s*(\d+)\s*$/m);
  const currentNameMatch = section.match(/^name:\s*(.+)$/m);
  if (
    currentNumberMatch &&
    currentNameMatch &&
    Number.parseInt(currentNumberMatch[1], 10) === unresolvedTest.number &&
    currentNameMatch[1].trim() === unresolvedTest.name
  ) {
    return;
  }

  const replacement = [
    "## Current Test",
    "",
    `number: ${unresolvedTest.number}`,
    `name: ${unresolvedTest.name}`,
    "expected: |",
    ...unresolvedTest.expected.split("\n").map((line) => `  ${line}`),
    "awaiting: user response",
  ].join("\n");
  const updated = content.replace(
    /##\s*Current Test\s*(?:\n<!--[\s\S]*?-->)?\n([\s\S]*?)(?=\n##\s|$)/i,
    replacement,
  );
  fs.writeFileSync(filePath, updated, "utf8");
}

function buildCheckpoint(currentTest) {
  return [
    "╔══════════════════════════════════════════════════════════════╗",
    "║  CHECKPOINT: Verification Required                           ║",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
    `**Test ${currentTest.number}: ${currentTest.name}**`,
    "",
    currentTest.expected,
    "",
    "──────────────────────────────────────────────────────────────",
    "Type `pass` or describe what's wrong.",
    "──────────────────────────────────────────────────────────────",
  ].join("\n");
}

function parseUatItems(content) {
  return parseTests(content)
    .filter(
      (test) =>
        test.result === "pending" ||
        test.result === "blocked" ||
        (test.result === "skipped" && (!test.reason || test.reason.trim().length === 0)),
    )
    .map((test) => {
      const item = {
        test: test.number,
        name: test.name,
        expected: test.expected,
        result: test.result,
        category: categorizeItem(test.result, test.reason, test.blocked_by),
      };
      if (test.reason) item.reason = test.reason;
      if (test.blocked_by) item.blocked_by = test.blocked_by;
      return item;
    });
}

function parseVerificationItems(content, status) {
  const items = [];
  if (status === "human_needed") {
    const frontmatterItems = [];
    for (const entry of parseHumanVerificationFrontmatter(content)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const result = typeof entry.result === "string" ? entry.result.trim() : "";
      if (/^pass$/i.test(result) || /^resolved$/i.test(result)) {
        continue;
      }
      const testNumber =
        typeof entry.test === "number"
          ? entry.test
          : typeof entry.test === "string" && /^\d+$/.test(entry.test)
            ? Number.parseInt(entry.test, 10)
            : undefined;
      const name =
        typeof entry.name === "string"
          ? entry.name.trim()
          : typeof entry.description === "string"
            ? entry.description.trim()
            : typeof entry.test === "string" && !/^\d+$/.test(entry.test)
              ? entry.test.trim()
              : "";
      if (name.length === 0) {
        continue;
      }
      frontmatterItems.push({
        ...(testNumber === undefined ? {} : { test: testNumber }),
        name,
        result: "human_needed",
        category: "human_uat",
        ...(typeof entry.expected === "string" && entry.expected.trim().length > 0
          ? { expected: entry.expected.trim() }
          : {}),
        ...(typeof entry.why_human === "string" && entry.why_human.trim().length > 0
          ? { why_human: entry.why_human.trim() }
          : {}),
      });
    }
    items.push(...frontmatterItems);

    const seenKeys = new Set(
      frontmatterItems.map((item) => `${item.test ?? ""}::${item.name.toLowerCase()}`),
    );

    // Extract from human_verification section — look for numbered items or table rows
    const hvSection = content.match(
      /##\s*(?:Human Verification|human_verification)(?:\s*\([^\n]*\))?.*?\n([\s\S]*?)(?=\n##\s|\n---\s|$)/i,
    );
    if (hvSection) {
      const lines = hvSection[1].split("\n");
      for (const line of lines) {
        // Match table rows: | N | description | ... |
        const tableMatch = line.match(/\|\s*(\d+)\s*\|\s*([^|]+)/);
        // Match bullet items: - description
        const bulletMatch = line.match(/^[-*]\s+(.+)/);
        // Match numbered items: 1. description
        const numberedMatch = line.match(/^(\d+)\.\s+(.+)/);

        if (tableMatch) {
          // Skip rows that already have a passing result (PASS, pass, resolved, etc.)
          const rowRemainder = line.slice(tableMatch.index + tableMatch[0].length);
          const cellValues = rowRemainder.split("|").map((c) => c.trim());
          const hasPassResult = cellValues.some((c) => /^pass$/i.test(c) || /^resolved$/i.test(c));
          if (hasPassResult) continue;
          const item = {
            test: parseInt(tableMatch[1], 10),
            name: tableMatch[2].trim(),
            result: "human_needed",
            category: "human_uat",
          };
          const key = `${item.test}::${item.name.toLowerCase()}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          items.push(item);
        } else if (numberedMatch) {
          const item = {
            test: parseInt(numberedMatch[1], 10),
            name: numberedMatch[2].trim(),
            result: "human_needed",
            category: "human_uat",
          };
          const key = `${item.test}::${item.name.toLowerCase()}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          items.push(item);
        } else if (bulletMatch && bulletMatch[1].length > 10) {
          const item = {
            name: bulletMatch[1].trim(),
            result: "human_needed",
            category: "human_uat",
          };
          const key = `::${item.name.toLowerCase()}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          items.push(item);
        }
      }
    }
  }
  // gaps_found items are already handled by plan-phase --gaps pipeline
  return items;
}

function categorizeItem(result, reason, blockedBy) {
  if (result === "blocked" || blockedBy) {
    if (blockedBy) {
      if (/server/i.test(blockedBy)) return "server_blocked";
      if (/device|physical/i.test(blockedBy)) return "device_needed";
      if (/build|release|preview/i.test(blockedBy)) return "build_needed";
      if (/third.party|twilio|stripe/i.test(blockedBy)) return "third_party";
    }
    return "blocked";
  }
  if (result === "skipped") {
    if (reason) {
      if (/server|not running|not available/i.test(reason)) return "server_blocked";
      if (/simulator|physical|device/i.test(reason)) return "device_needed";
      if (/build|release|preview/i.test(reason)) return "build_needed";
    }
    return "skipped_unresolved";
  }
  if (result === "pending") return "pending";
  if (result === "human_needed") return "human_uat";
  return "unknown";
}

module.exports = {
  cmdAuditUat,
  cmdRenderCheckpoint,
  parseCurrentTest,
  parseTests,
  rewriteCurrentTestForResume,
  buildCheckpoint,
};

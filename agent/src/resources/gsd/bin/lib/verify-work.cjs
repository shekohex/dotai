const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { planningDir } = require("./planning-workspace.cjs");
const { output, error, toPosixPath, filterSummaryFiles, extractPhaseToken } = require("./core.cjs");
const { extractFrontmatter } = require("./frontmatter.cjs");
const { requireSafePath } = require("./security.cjs");

const ACTIVE_UAT_STATUSES = new Set(["testing", "partial"]);
const PASS_TOKENS = new Set(["", "yes", "y", "ok", "pass", "next", "approved", "✓"]);
const SKIP_TOKENS = new Set(["skip", "can't test", "n/a"]);

function parseGapValue(raw) {
  if (raw === "[]") return [];
  if (raw === '""' || raw === "''") return "";
  return raw.replace(/^"|"$/g, "").trim();
}

function parseGaps(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sectionMatch = normalized.match(/##\s*Gaps\s*\n([\s\S]*?)$/i);
  if (!sectionMatch) return [];
  const section = sectionMatch[1]
    .split("\n")
    .filter((line) => !/^<!--/.test(line.trim()))
    .join("\n");
  const blocks = section
    .split(/\n(?=-\s+truth:)/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("- truth:"));
  return blocks.map((block) => {
    const gap = {
      truth: "",
      status: "failed",
      reason: "",
      severity: "major",
      test: 0,
      root_cause: "",
      artifacts: [],
      missing: [],
      debug_session: "",
    };
    let currentListKey = null;
    for (const line of block.split("\n")) {
      const topLevel = line.match(/^(\s{0,2})(?:-\s+)?([a-z_]+):\s*(.*)$/i);
      if (topLevel) {
        const key = topLevel[2];
        const value = topLevel[3].trim();
        if (key === "artifacts" || key === "missing") {
          currentListKey = key;
          gap[key] = value === "[]" ? [] : [];
          continue;
        }
        currentListKey = null;
        if (key === "test") gap.test = Number.parseInt(value, 10);
        else gap[key] = parseGapValue(value);
        continue;
      }
      const listItem = line.match(/^\s+-\s+(.*)$/);
      if (!listItem || !currentListKey) continue;
      const value = listItem[1].trim();
      if (currentListKey === "artifacts" && /^path:\s*/.test(value)) {
        gap.artifacts.push({ path: value.replace(/^path:\s*/, "").replace(/^"|"$/g, "") });
      } else if (currentListKey === "artifacts") {
        gap.artifacts.push(parseGapValue(value));
      } else {
        gap.missing.push(parseGapValue(value));
      }
    }
    return gap;
  });
}

function renderExpectedBlock(expected) {
  if (!expected.includes("\n")) return `expected: ${expected}`;
  return ["expected: |", ...expected.split("\n").map((line) => `  ${line}`)].join("\n");
}

function renderTestBlock(test) {
  const lines = [
    `### ${test.number}. ${test.name}`,
    "",
    renderExpectedBlock(test.expected),
    `result: ${test.result}`,
  ];
  if (test.reported) lines.push(`reported: "${test.reported.replace(/"/g, '\\"')}"`);
  if (test.severity) lines.push(`severity: ${test.severity}`);
  if (test.reason) lines.push(`reason: ${test.reason}`);
  if (test.blocked_by) lines.push(`blocked_by: ${test.blocked_by}`);
  return lines.join("\n");
}

function renderGapBlock(gap) {
  const lines = [
    `- truth: "${String(gap.truth).replace(/"/g, '\\"')}"`,
    `  status: ${gap.status}`,
    `  reason: "${String(gap.reason).replace(/"/g, '\\"')}"`,
    `  severity: ${gap.severity}`,
    `  test: ${gap.test}`,
    `  root_cause: "${String(gap.root_cause || "").replace(/"/g, '\\"')}"`,
  ];
  if (Array.isArray(gap.artifacts) && gap.artifacts.length > 0) {
    lines.push("  artifacts:");
    for (const artifact of gap.artifacts) {
      if (artifact && typeof artifact === "object" && typeof artifact.path === "string") {
        lines.push(`    - path: "${artifact.path.replace(/"/g, '\\"')}"`);
        if (typeof artifact.issue === "string" && artifact.issue.length > 0) {
          lines.push(`      issue: "${artifact.issue.replace(/"/g, '\\"')}"`);
        }
      } else {
        lines.push(`    - "${String(artifact).replace(/"/g, '\\"')}"`);
      }
    }
  } else {
    lines.push("  artifacts: []");
  }
  if (Array.isArray(gap.missing) && gap.missing.length > 0) {
    lines.push("  missing:");
    for (const missing of gap.missing)
      lines.push(`    - "${String(missing).replace(/"/g, '\\"')}"`);
  } else {
    lines.push("  missing: []");
  }
  lines.push(`  debug_session: "${String(gap.debug_session || "").replace(/"/g, '\\"')}"`);
  return lines.join("\n");
}

function parseUatDocument(content) {
  return {
    frontmatter: extractFrontmatter(content),
    tests: parseTests(content),
    gaps: parseGaps(content),
  };
}

function normalizeReportedResponse(response) {
  const raw = (response ?? "").trim();
  return raw.length > 0 ? raw : "pass";
}

function computeTerminalStatus(tests, gaps) {
  const unresolvedStatus = computeCompletionStatus(tests);
  if (unresolvedStatus === "partial") return "partial";
  const issueGaps = gaps.filter((gap) => Number.isFinite(gap.test) && gap.test > 0);
  if (
    issueGaps.length > 0 &&
    issueGaps.every((gap) => String(gap.root_cause || "").trim().length > 0)
  ) {
    return "diagnosed";
  }
  return "complete";
}

function resolveDocumentStatus(frontmatter, tests, gaps) {
  const status = String(frontmatter.status || "").trim();
  if (status === "diagnosed") {
    return "diagnosed";
  }
  return computeTerminalStatus(tests, gaps);
}

function buildCurrentTestSection(tests) {
  const nextTest = findFirstUnresolvedTest(tests);
  if (!nextTest) return "[testing complete]";
  return [
    `number: ${nextTest.number}`,
    `name: ${nextTest.name}`,
    renderExpectedBlock(nextTest.expected),
    "awaiting: user response",
  ].join("\n");
}

function renderUatDocument(document) {
  const summary = summarizeTests(document.tests);
  const frontmatter = document.frontmatter;
  return [
    "---",
    `status: ${computeTerminalStatus(document.tests, document.gaps)}`,
    `phase: ${frontmatter.phase}`,
    `source: ${frontmatter.source}`,
    `started: ${frontmatter.started}`,
    `updated: ${new Date().toISOString()}`,
    "---",
    "",
    "## Current Test",
    "",
    buildCurrentTestSection(document.tests),
    "",
    "## Tests",
    "",
    document.tests.map((test) => renderTestBlock(test)).join("\n\n"),
    "",
    "## Summary",
    "",
    `total: ${summary.total}`,
    `passed: ${summary.passed}`,
    `issues: ${summary.issues}`,
    `pending: ${summary.pending}`,
    `skipped: ${summary.skipped}`,
    `blocked: ${summary.blocked}`,
    "",
    "## Gaps",
    "",
    document.gaps.length > 0 ? document.gaps.map((gap) => renderGapBlock(gap)).join("\n\n") : "",
    "",
  ].join("\n");
}

function updateGapForIssue(gaps, test, response, severity) {
  const existingGap = gaps.find((gap) => gap.test === test.number);
  const nextGap = {
    truth: test.expected,
    status: "failed",
    reason: `User reported: ${response}`,
    severity,
    test: test.number,
    root_cause: existingGap?.root_cause || "",
    artifacts: existingGap?.artifacts || [],
    missing: existingGap?.missing || [],
    debug_session: existingGap?.debug_session || "",
  };
  if (existingGap) Object.assign(existingGap, nextGap);
  else gaps.push(nextGap);
}

function loadDiagnosisInput(value, cwd) {
  if (typeof value !== "string" || value.trim().length === 0) {
    error("verify-work apply-diagnosis requires --diagnosis <json-or-file>");
  }
  const trimmed = value.trim();
  const potentialPath = path.resolve(cwd, trimmed);
  const input = fs.existsSync(potentialPath) ? fs.readFileSync(potentialPath, "utf8") : trimmed;
  return JSON.parse(input);
}

function loadJsonFromStdout(fn) {
  return fn();
}

function loadInitVerifyWork(cwd, phase) {
  const toolPath = path.join(__dirname, "..", "gsd-tools.cjs");
  return JSON.parse(
    execFileSync("node", [toolPath, "init", "verify-work", String(phase)], {
      cwd,
      encoding: "utf8",
    }),
  );
}

function findUatFileForPhaseDir(cwd, phaseDir) {
  const files = fs.readdirSync(path.join(cwd, phaseDir));
  const uatFile = files.find((file) => file.endsWith("-UAT.md") || file === "UAT.md");
  return uatFile ? path.join(cwd, phaseDir, uatFile) : null;
}

function normalizePhaseSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractPhaseDirSlug(dirName) {
  const match = dirName.match(/^(?:[A-Z]{1,6}-)?(?:\d+[A-Z]?(?:\.\d+)*)-?(.*)$/i);
  return normalizePhaseSlug(match?.[1] || "");
}

function normalizeSessionPhaseId(value) {
  const token = extractPhaseToken(String(value || ""));
  const numericToken = token.replace(/^[A-Z]{1,6}-(?=\d)/i, "");
  const match = numericToken.match(/^(\d+)([A-Z]?(?:\.\d+)*)$/i);
  if (!match) {
    return numericToken || String(value || "");
  }
  return `${String(Number.parseInt(match[1], 10))}${match[2] || ""}`;
}

function resolvePhaseDir(cwd, phase, initResult) {
  if (initResult.phase_dir) {
    const fromInit = path.join(cwd, initResult.phase_dir);
    if (fs.existsSync(fromInit) && fs.statSync(fromInit).isDirectory()) {
      return fromInit;
    }
  }
  if (initResult.phase_dir_fallback_allowed !== true) {
    return null;
  }
  const phasesDir = path.join(planningDir(cwd), "phases");
  if (!fs.existsSync(phasesDir)) {
    return null;
  }
  const target = String(initResult.phase_number || phase);
  const matches = fs
    .readdirSync(phasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => normalizeSessionPhaseId(name) === target);
  if (matches.length === 0) {
    return null;
  }
  const expectedSlug = normalizePhaseSlug(initResult.phase_name);
  const match = expectedSlug
    ? matches.find((name) => extractPhaseDirSlug(name) === expectedSlug) || null
    : matches[0];
  return match ? path.join(phasesDir, match) : null;
}

function parseTests(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sectionMatch = normalized.match(/##\s*Tests\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!sectionMatch) {
    return [];
  }

  const blocks = sectionMatch[1]
    .split(/\n(?=###\s*\d+\.\s*)/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const tests = [];
  for (const block of blocks) {
    const heading = block.match(/^###\s*(\d+)\.\s*(.+)$/m);
    const expectedBlock =
      block.match(/^expected:\s*\|\n([\s\S]*?)(?=^\w[\w-]*:\s)/m) ||
      block.match(/^expected:\s*\|\n([\s\S]+)/m);
    const expectedInline = block.match(/^expected:\s*(.+)$/m);
    const resultMatch = block.match(/^result:\s*\[?(\w+)\]?\s*$/m);
    const reportedMatch = block.match(/^reported:\s*"?(.+?)"?\s*$/m);
    const severityMatch = block.match(/^severity:\s*(\w+)\s*$/m);
    const reasonMatch = block.match(/^reason:\s*(.+)\s*$/m);
    const blockedByMatch = block.match(/^blocked_by:\s*(.+)\s*$/m);
    if (!heading || !resultMatch || (!expectedBlock && !expectedInline)) {
      continue;
    }
    const expected = expectedBlock
      ? expectedBlock[1]
          .split("\n")
          .map((line) => line.replace(/^ {2}/, ""))
          .join("\n")
          .trim()
      : expectedInline[1].trim();
    tests.push({
      number: Number.parseInt(heading[1], 10),
      name: heading[2].trim(),
      expected,
      result: resultMatch[1].trim(),
      reported: reportedMatch?.[1]?.trim(),
      severity: severityMatch?.[1]?.trim(),
      reason: reasonMatch?.[1]?.trim(),
      blocked_by: blockedByMatch?.[1]?.trim(),
    });
  }

  return tests;
}

function computeCompletionStatus(tests) {
  const hasPending = tests.some((test) => test.result === "pending");
  const hasBlocked = tests.some((test) => test.result === "blocked");
  const hasSkippedWithoutReason = tests.some(
    (test) => test.result === "skipped" && (!test.reason || test.reason.trim().length === 0),
  );
  return hasPending || hasBlocked || hasSkippedWithoutReason ? "partial" : "complete";
}

function findFirstUnresolvedTest(tests) {
  return (
    tests.find(
      (test) =>
        test.result === "pending" ||
        test.result === "blocked" ||
        (test.result === "skipped" && (!test.reason || test.reason.trim().length === 0)),
    ) || null
  );
}

function summarizeTests(tests) {
  return {
    total: tests.length,
    passed: tests.filter((test) => test.result === "pass").length,
    issues: tests.filter((test) => test.result === "issue").length,
    pending: tests.filter((test) => test.result === "pending").length,
    skipped: tests.filter((test) => test.result === "skipped").length,
    blocked: tests.filter((test) => test.result === "blocked").length,
  };
}

function classifyResponse(response) {
  const raw = (response ?? "").trim();
  const lowered = raw.toLowerCase();
  if (PASS_TOKENS.has(lowered)) {
    return { kind: "pass" };
  }
  if (SKIP_TOKENS.has(lowered)) {
    return { kind: "skipped" };
  }

  const blockerCategory = inferBlockedBy(raw);
  if (blockerCategory !== null) {
    return { kind: "blocked", blocked_by: blockerCategory };
  }

  if (
    /^can't test(?:\s+(?:on|in|with|without)\b|$)|^cannot test(?:\s+(?:on|in|with|without)\b|$)/i.test(
      raw,
    )
  ) {
    return { kind: "skipped" };
  }

  return { kind: "issue", severity: inferSeverity(raw) };
}

function inferBlockedBy(response) {
  const lowered = response.toLowerCase();
  const hasBareEnvironmentBlocker =
    /\bserver not running\b|\bserver unavailable\b|\bbackend down\b|\bapi down\b|\bpreview build unavailable\b|\brelease build unavailable\b|\bno preview build\b|\bno release build\b|\bneed (a )?physical device\b|\bphysical device required\b|\bdevice unavailable\b/i.test(
      response,
    );
  const hasBlockedPhrase =
    hasBareEnvironmentBlocker ||
    /\bdepends on\b/.test(lowered) ||
    /\bblocked by (server|api|gateway|preview build|release build|eas build|physical device|device|stripe|twilio|oauth|sso|vendor|external service|migration|prerequisite)\b/.test(
      lowered,
    ) ||
    /\bblocked by previous phase\b/.test(lowered) ||
    /\bblocked by previous phase bug\b/.test(lowered) ||
    /\bneed (a )?(physical device|device|release build|preview build|eas build)\b/.test(lowered) ||
    /\bneed (oauth|stripe|twilio|sso) config\b/.test(lowered) ||
    /\brequires? (a |an )?(physical device|device|release build|preview build|eas build|server|gateway|migration|prerequisite)\b/.test(
      lowered,
    ) ||
    /\buntil (preview build|release build|eas build|server|gateway|migration|prerequisite)\b/.test(
      lowered,
    ) ||
    /\b(can'?t test|cannot test|can'?t proceed|cannot proceed|waiting on|waiting for)\b.*\b(server|api|gateway|preview build|release build|eas build|physical device|device|stripe|twilio|oauth|sso|vendor|external service|migration|prerequisite|config)\b/.test(
      lowered,
    );
  if (!hasBlockedPhrase) {
    return null;
  }
  if (
    /\bserver\b|not running|backend down|api down|dev server|server not|api gateway|gateway/i.test(
      response,
    )
  ) {
    return "server";
  }
  if (
    /physical device|real device|actual device|need (a )?device|ios device|android device/i.test(
      response,
    )
  ) {
    return "physical-device";
  }
  if (
    /release build|production build|preview build|testflight|app store build|play store build|eas build|preview/i.test(
      response,
    )
  ) {
    return "release-build";
  }
  if (
    /stripe|twilio|oauth|sso|third.party|third party|vendor|external service|config/i.test(response)
  ) {
    return "third-party";
  }
  if (
    /prior phase|previous phase|depends on prior phase|depends on previous phase|waiting on phase|depends on prerequisite|prerequisite migration|prerequisite|previous phase bug/i.test(
      response,
    )
  ) {
    return "prior-phase";
  }
  return "other";
}

function inferSeverity(response) {
  const lowered = response.toLowerCase();
  if (
    /crash|crashes|exception|fatal|unusable|fails completely|won't start|doesn't start|panic/.test(
      lowered,
    )
  ) {
    return "blocker";
  }
  if (/spacing|color|font|alignment|visual|looks off|ui polish|cosmetic/.test(lowered)) {
    return "cosmetic";
  }
  if (/works but|slow|sluggish|minor|small issue|laggy|delayed/.test(lowered)) {
    return "minor";
  }
  return "major";
}

function listActiveSessions(cwd) {
  const phasesDir = path.join(planningDir(cwd), "phases");
  if (!fs.existsSync(phasesDir)) {
    return [];
  }
  const sessions = [];
  for (const dirent of fs.readdirSync(phasesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const phaseDir = path.join(phasesDir, dirent.name);
    const files = fs.readdirSync(phaseDir);
    for (const file of files.filter((entry) => entry.endsWith("-UAT.md") || entry === "UAT.md")) {
      const absolutePath = path.join(phaseDir, file);
      const content = fs.readFileSync(absolutePath, "utf8");
      const frontmatter = extractFrontmatter(content);
      const status = String(frontmatter.status || "testing");
      if (!ACTIVE_UAT_STATUSES.has(status)) {
        continue;
      }
      const tests = parseTests(content);
      const counts = summarizeTests(tests);
      sessions.push({
        phase: normalizeSessionPhaseId(frontmatter.phase || dirent.name),
        phase_dir: toPosixPath(path.relative(cwd, phaseDir)),
        file_path: toPosixPath(path.relative(cwd, absolutePath)),
        status,
        counts,
      });
    }
  }
  return sessions.sort((left, right) =>
    left.phase.localeCompare(right.phase, undefined, { numeric: true }),
  );
}

function listCandidatePhases(cwd) {
  const phasesDir = path.join(planningDir(cwd), "phases");
  if (!fs.existsSync(phasesDir)) {
    return [];
  }
  const candidates = [];
  for (const dirent of fs.readdirSync(phasesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const phaseDir = path.join(phasesDir, dirent.name);
    const files = fs.readdirSync(phaseDir);
    const summaryFiles = filterSummaryFiles(files);
    if (summaryFiles.length === 0) {
      continue;
    }
    candidates.push({
      phase: normalizeSessionPhaseId(dirent.name),
      phase_dir: toPosixPath(path.relative(cwd, phaseDir)),
      summary_files: summaryFiles,
    });
  }
  return candidates.sort((left, right) =>
    left.phase.localeCompare(right.phase, undefined, { numeric: true }),
  );
}

function parseObservableTestsFromSummary(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const tests = [];
  const observableSections = ["Accomplishments", "User-Facing Changes", "User Facing Changes"];
  for (const sectionName of observableSections) {
    const sectionMatch = normalized.match(
      new RegExp(`##\\s*${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i"),
    );
    if (!sectionMatch) {
      continue;
    }
    for (const line of sectionMatch[1].split("\n")) {
      const bullet = line.match(/^[-*]\s+(.+)$/);
      if (!bullet) {
        continue;
      }
      const text = bullet[1].trim();
      if (text.length === 0 || /^internal[- ]only:/i.test(text)) {
        continue;
      }
      tests.push(text);
    }
  }
  if (tests.length === 0) {
    const oneLinerMatch = normalized.match(/^#[^\n]*\n+\*\*([^*\n]+)\*\*([^\n]*)/m);
    if (oneLinerMatch) {
      const headline = /:\s*$/.test(oneLinerMatch[1].trim())
        ? oneLinerMatch[2].trim()
        : oneLinerMatch[1].trim();
      if (headline && !/^internal[- ]only:/i.test(headline)) {
        tests.push(headline);
      }
    }
  }
  return [...new Set(tests)];
}

function extractTouchedFilePathsFromSummary(content) {
  const frontmatter = extractFrontmatter(content);
  const filePaths = [];
  const keyFiles = frontmatter["key-files"];
  if (keyFiles && typeof keyFiles === "object") {
    if (Array.isArray(keyFiles.created)) {
      filePaths.push(...keyFiles.created.filter((value) => typeof value === "string"));
    }
    if (Array.isArray(keyFiles.modified)) {
      filePaths.push(...keyFiles.modified.filter((value) => typeof value === "string"));
    }
  }

  const filesSection = content.match(/##\s*Files Created\/Modified\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (filesSection) {
    for (const line of filesSection[1].split("\n")) {
      const match = line.match(/^[-*]\s+`([^`]+)`/);
      if (match) {
        filePaths.push(match[1].trim());
      }
    }
  }

  return [...new Set(filePaths)];
}

function hasColdStartRisk(filePaths) {
  return filePaths.some((filePath) =>
    /(^|\/)(main|index|app|server|entry|bootstrap|middleware|layout|root|startup[^/]*|app\.config|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|docker-compose|Dockerfile)(\.|$)|(^|\/)(vite|next|nuxt|expo|capacitor|tauri|electron|webpack|metro|babel|tsconfig|env|database|db|seed|seeds|migrations)(\/|\.|$)/i.test(
      filePath,
    ),
  );
}

function renderUatArtifact({ phaseSlug, sourceFiles, tests, now }) {
  const testBlocks = tests
    .map((test, index) =>
      [
        `### ${index + 1}. ${test.name}`,
        "",
        `expected: ${test.expected}`,
        "result: [pending]",
        "",
      ].join("\n"),
    )
    .join("\n");
  const firstTest = tests[0];
  return [
    "---",
    "status: testing",
    `phase: ${phaseSlug}`,
    `source: ${sourceFiles.join(", ")}`,
    `started: ${now}`,
    `updated: ${now}`,
    "---",
    "",
    "## Current Test",
    "",
    firstTest
      ? [
          `number: ${firstTest.number}`,
          `name: ${firstTest.name}`,
          `expected: ${firstTest.expected}`,
          "awaiting: user response",
        ].join("\n")
      : "[testing complete]",
    "",
    "## Tests",
    "",
    testBlocks.trimEnd(),
    "",
    "## Summary",
    "",
    `total: ${tests.length}`,
    "passed: 0",
    "issues: 0",
    `pending: ${tests.length}`,
    "skipped: 0",
    "blocked: 0",
    "",
    "## Gaps",
    "",
  ].join("\n");
}

function createArtifactForPhase(cwd, phase) {
  const initResult = loadJsonFromStdout(() => loadInitVerifyWork(cwd, phase));
  const phaseDir = resolvePhaseDir(cwd, phase, initResult);
  if (!initResult.phase_found || !phaseDir) {
    error(`Phase ${phase} directory not found for verify-work`);
  }
  const files = fs.readdirSync(phaseDir);
  const summaryFiles = filterSummaryFiles(files);
  if (summaryFiles.length === 0) {
    error(`Phase ${phase} has no SUMMARY.md files to verify`);
  }

  const tests = [];
  const sourceFiles = [];
  let startupRisk = false;
  for (const summaryFile of summaryFiles) {
    const summaryPath = path.join(phaseDir, summaryFile);
    const content = fs.readFileSync(summaryPath, "utf8");
    sourceFiles.push(summaryFile);
    startupRisk ||= hasColdStartRisk(extractTouchedFilePathsFromSummary(content));
    for (const observable of parseObservableTestsFromSummary(content)) {
      tests.push({ name: observable, expected: observable });
    }
  }

  const dedupedTests = [];
  const seen = new Set();
  if (startupRisk) {
    seen.add("Cold start smoke test");
    dedupedTests.push({
      number: 1,
      name: "Cold start smoke test",
      expected: "App cold-starts successfully without manual recovery",
    });
  }
  for (const test of tests) {
    if (seen.has(test.name)) {
      continue;
    }
    seen.add(test.name);
    dedupedTests.push({
      number: dedupedTests.length + 1,
      name: test.name,
      expected: test.expected,
    });
  }

  if (dedupedTests.length === 0) {
    error(`Phase ${phase} has no user-observable tests to verify after filtering summaries`);
  }

  const now = new Date().toISOString();
  const phaseSlug = `${initResult.phase_number}-${String(initResult.phase_name || "phase")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
  const filePath = path.join(
    phaseDir,
    `${String(initResult.phase_number).padStart(2, "0")}-UAT.md`,
  );
  fs.writeFileSync(
    filePath,
    renderUatArtifact({ phaseSlug, sourceFiles, tests: dedupedTests, now }),
    "utf8",
  );
  return {
    action: "created",
    file_path: toPosixPath(path.relative(cwd, filePath)),
    counts: summarizeTests(parseTests(fs.readFileSync(filePath, "utf8"))),
  };
}

function cmdVerifyWorkSession(cwd, options, raw) {
  const phase = options.phase;
  if (!phase) {
    const sessions = listActiveSessions(cwd);
    const phases = listCandidatePhases(cwd);
    if (sessions.length === 0) {
      output(
        {
          action: "prompt-phase",
          prompt: "Enter phase number to start verify-work.",
          phases,
        },
        raw,
      );
      return;
    }
    if (sessions.length === 1) {
      output(
        {
          action: "choose-session-or-phase",
          prompt: "Choose session number to resume or start new by phase number.",
          sessions,
          phases,
        },
        raw,
      );
      return;
    }
    output(
      {
        action: "choose-session-or-phase",
        prompt: "Choose session number to resume or start new by phase number.",
        sessions,
        phases,
      },
      raw,
    );
    return;
  }

  const initResult = loadJsonFromStdout(() => loadInitVerifyWork(cwd, phase));
  if (!initResult.phase_found) {
    error(`Phase ${phase} not found`);
  }
  const fallbackDir = resolvePhaseDir(cwd, phase, initResult);
  if (!initResult.phase_dir && !fallbackDir) {
    output(
      {
        action: "missing-phase-dir",
        phase: initResult.phase_number,
        phase_name: initResult.phase_name,
        prompt: "Phase exists in ROADMAP but no phase directory exists yet.",
      },
      raw,
    );
    return;
  }
  const phaseDir = initResult.phase_dir || toPosixPath(path.relative(cwd, fallbackDir));
  const existingUatFile = findUatFileForPhaseDir(cwd, phaseDir);
  if (!existingUatFile) {
    output(
      {
        action: "bootstrap-new",
        phase: initResult.phase_number,
        phase_name: initResult.phase_name,
      },
      raw,
    );
    return;
  }
  output(
    {
      action: "resume-or-restart",
      phase: initResult.phase_number,
      phase_name: initResult.phase_name,
      file_path: toPosixPath(path.relative(cwd, existingUatFile)),
    },
    raw,
  );
}

function cmdVerifyWorkCreate(cwd, options, raw) {
  const result = createArtifactForPhase(cwd, options.phase);
  output(result, raw);
}

function cmdVerifyWorkClassify(_cwd, options, raw) {
  if (typeof options.response !== "string") {
    error("verify-work classify requires --response <text>");
  }
  output(classifyResponse(options.response), raw);
}

function cmdVerifyWorkStatus(cwd, options, raw) {
  const resolvedPath = requireSafePath(options.file, cwd, "UAT file", { allowAbsolute: true });
  const content = fs.readFileSync(resolvedPath, "utf8");
  const document = parseUatDocument(content);
  const tests = document.tests;
  const hasTestsSection = /##\s*Tests\s*\n/i.test(
    content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
  );
  if (!hasTestsSection || tests.length === 0) {
    error("UAT file is missing parseable Tests entries");
  }
  output(
    {
      status: resolveDocumentStatus(document.frontmatter, tests, document.gaps),
      counts: summarizeTests(tests),
    },
    raw,
  );
}

function cmdVerifyWorkApplyResponse(cwd, options, raw) {
  const resolvedPath = requireSafePath(options.file, cwd, "UAT file", { allowAbsolute: true });
  const response = typeof options.response === "string" ? options.response : undefined;
  if (!response) error("verify-work apply-response requires --response <text>");
  const document = parseUatDocument(fs.readFileSync(resolvedPath, "utf8"));
  const activeTest = findFirstUnresolvedTest(document.tests);
  if (!activeTest) error("UAT session is already complete");

  const classification = classifyResponse(response);
  delete activeTest.reported;
  delete activeTest.severity;
  delete activeTest.reason;
  delete activeTest.blocked_by;

  if (classification.kind === "pass") {
    activeTest.result = "pass";
  } else if (classification.kind === "issue") {
    activeTest.result = "issue";
    activeTest.reported = normalizeReportedResponse(response);
    activeTest.severity = classification.severity;
    updateGapForIssue(
      document.gaps,
      activeTest,
      normalizeReportedResponse(response),
      classification.severity,
    );
  } else if (classification.kind === "blocked") {
    activeTest.result = "blocked";
    activeTest.blocked_by = classification.blocked_by;
    activeTest.reason = normalizeReportedResponse(response);
  } else {
    activeTest.result = "skipped";
    const lowered = response.trim().toLowerCase();
    if (!SKIP_TOKENS.has(lowered) || lowered === "can't test") {
      activeTest.reason = normalizeReportedResponse(response);
    }
  }

  fs.writeFileSync(resolvedPath, renderUatDocument(document), "utf8");
  output(
    {
      file_path: toPosixPath(path.relative(cwd, resolvedPath)),
      applied_to_test: activeTest.number,
      classification,
      status: computeTerminalStatus(document.tests, document.gaps),
      counts: summarizeTests(document.tests),
      current_test: findFirstUnresolvedTest(document.tests)?.number || null,
    },
    raw,
  );
}

function cmdVerifyWorkApplyDiagnosis(cwd, options, raw) {
  const resolvedPath = requireSafePath(options.file, cwd, "UAT file", { allowAbsolute: true });
  const diagnoses = loadDiagnosisInput(options.diagnosis, cwd);
  const document = parseUatDocument(fs.readFileSync(resolvedPath, "utf8"));
  for (const entry of Array.isArray(diagnoses) ? diagnoses : [diagnoses]) {
    const gap = document.gaps.find((item) => item.test === Number(entry.test));
    if (!gap) continue;
    if (typeof entry.root_cause === "string") gap.root_cause = entry.root_cause;
    if (Array.isArray(entry.artifacts)) gap.artifacts = entry.artifacts;
    if (Array.isArray(entry.missing)) gap.missing = entry.missing;
    if (typeof entry.debug_session === "string") gap.debug_session = entry.debug_session;
  }
  fs.writeFileSync(resolvedPath, renderUatDocument(document), "utf8");
  output(
    {
      file_path: toPosixPath(path.relative(cwd, resolvedPath)),
      status: computeTerminalStatus(document.tests, document.gaps),
      diagnosed: document.gaps
        .filter((gap) => String(gap.root_cause || "").trim().length > 0)
        .map((gap) => gap.test),
    },
    raw,
  );
}

module.exports = {
  ACTIVE_UAT_STATUSES,
  classifyResponse,
  cmdVerifyWorkApplyDiagnosis,
  cmdVerifyWorkApplyResponse,
  cmdVerifyWorkClassify,
  cmdVerifyWorkCreate,
  cmdVerifyWorkSession,
  cmdVerifyWorkStatus,
  computeCompletionStatus,
  inferBlockedBy,
  inferSeverity,
  listActiveSessions,
  findFirstUnresolvedTest,
  extractTouchedFilePathsFromSummary,
  parseObservableTestsFromSummary,
  parseGaps,
  parseTests,
  renderUatDocument,
  resolvePhaseDir,
};

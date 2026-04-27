/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return */
function readRuleOptions(context) {
  const entries = Array.isArray(context.options) ? context.options : [];
  const objectEntry = entries.find(
    (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  return objectEntry ?? {};
}

export { readRuleOptions };

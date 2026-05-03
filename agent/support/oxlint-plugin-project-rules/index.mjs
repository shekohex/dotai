import { eslintCompatPlugin } from "@oxlint/plugins";
import { createNoDynamicImportRule } from "./rules/no-dynamic-import.mjs";
import { createNoInlineErrorMessageExtractionRule } from "./rules/no-inline-error-message-extraction.mjs";
import { createNoInlineImportTypeRule } from "./rules/no-inline-import-type.mjs";
import { createNoLocalUnknownRecordHelperRule } from "./rules/no-local-unknown-record-helper.mjs";
import { createNoRedundantRuntimeNarrowingRule } from "./rules/no-redundant-runtime-narrowing.mjs";
import { createNoRedundantCheckAfterTypeboxRule } from "./rules/no-redundant-check-after-typebox.mjs";
import { createNoObjectShapeCastFromUnknownRule } from "./rules/no-object-shape-cast-from-unknown.mjs";
import { createNoReflectOutsideAllowlistRule } from "./rules/no-reflect-outside-allowlist.mjs";
import { createNoUnsafeJsonParseRule } from "./rules/no-unsafe-json-parse.mjs";

const plugin = eslintCompatPlugin({
  meta: {
    name: "project-rules",
  },
  rules: {
    "no-dynamic-import": createNoDynamicImportRule(),
    "no-inline-error-message-extraction": createNoInlineErrorMessageExtractionRule(),
    "no-inline-import-type": createNoInlineImportTypeRule(),
    "no-local-unknown-record-helper": createNoLocalUnknownRecordHelperRule(),
    "no-object-shape-cast-from-unknown": createNoObjectShapeCastFromUnknownRule(),
    "no-redundant-check-after-typebox": createNoRedundantCheckAfterTypeboxRule(),
    "no-redundant-runtime-narrowing": createNoRedundantRuntimeNarrowingRule(),
    "no-reflect-outside-allowlist": createNoReflectOutsideAllowlistRule(),
    "no-unsafe-json-parse": createNoUnsafeJsonParseRule(),
  },
});

export default plugin;

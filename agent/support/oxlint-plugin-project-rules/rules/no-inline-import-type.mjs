/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access */
function createNoInlineImportTypeRule() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow inline import types.",
      },
      schema: [],
    },
    createOnce(context) {
      return {
        TSImportType(node) {
          context.report({
            node,
            message:
              'Inline import type syntax is forbidden here. Import the type at top level instead so dependencies stay explicit and refactors stay safe. Fix: add `import type { ... } from "..."` at file scope, then reference that imported type directly.',
          });
        },
      };
    },
  };
}

export { createNoInlineImportTypeRule };

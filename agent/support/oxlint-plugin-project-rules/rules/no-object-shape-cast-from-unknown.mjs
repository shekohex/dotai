/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/strict-boolean-expressions, unicorn/prefer-at */
function hasUnknownTypeAnnotation(identifier) {
  return (
    identifier?.type === "Identifier" &&
    identifier.typeAnnotation?.typeAnnotation?.type === "TSUnknownKeyword"
  );
}

function isShapeLikeType(typeNode) {
  return (
    typeNode?.type === "TSTypeLiteral" ||
    typeNode?.type === "TSMappedType" ||
    typeNode?.type === "TSInterfaceBody" ||
    typeNode?.type === "TSIntersectionType"
  );
}

function createNoObjectShapeCastFromUnknownRule() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow object-shape casts from unknown for property probing.",
      },
      schema: [],
    },
    createOnce(context) {
      const scopeStack = [];

      function enterScope() {
        scopeStack.push(new Set());
      }

      function exitScope() {
        scopeStack.pop();
      }

      function currentScope() {
        if (scopeStack.length === 0) {
          enterScope();
        }
        return scopeStack[scopeStack.length - 1];
      }

      function markUnknownIdentifier(identifier) {
        if (identifier?.type === "Identifier") {
          currentScope().add(identifier.name);
        }
      }

      function readsUnknownIdentifier(node) {
        if (node?.type !== "Identifier") {
          return false;
        }
        for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
          if (scopeStack[index]?.has(node.name)) {
            return true;
          }
        }
        return false;
      }

      return {
        Program() {
          enterScope();
        },
        "Program:exit"() {
          exitScope();
        },
        BlockStatement() {
          enterScope();
        },
        "BlockStatement:exit"() {
          exitScope();
        },
        FunctionDeclaration(node) {
          enterScope();
          for (const parameter of node.params ?? []) {
            if (hasUnknownTypeAnnotation(parameter)) {
              markUnknownIdentifier(parameter);
            }
          }
        },
        "FunctionDeclaration:exit"() {
          exitScope();
        },
        FunctionExpression(node) {
          enterScope();
          for (const parameter of node.params ?? []) {
            if (hasUnknownTypeAnnotation(parameter)) {
              markUnknownIdentifier(parameter);
            }
          }
        },
        "FunctionExpression:exit"() {
          exitScope();
        },
        ArrowFunctionExpression(node) {
          enterScope();
          for (const parameter of node.params ?? []) {
            if (hasUnknownTypeAnnotation(parameter)) {
              markUnknownIdentifier(parameter);
            }
          }
        },
        "ArrowFunctionExpression:exit"() {
          exitScope();
        },
        VariableDeclarator(node) {
          if (hasUnknownTypeAnnotation(node.id)) {
            markUnknownIdentifier(node.id);
          }
        },
        TSAsExpression(node) {
          if (!readsUnknownIdentifier(node.expression) || !isShapeLikeType(node.typeAnnotation)) {
            return;
          }
          context.report({
            node,
            message:
              "This object-shape cast is reading fields from a value that started as `unknown`. Do not pretend the shape exists with `as { ... }` or `as Partial<...>`. Fix: validate the boundary with TypeBox or write an explicit type guard using `in` checks, then read the properties from that validated value.",
          });
        },
      };
    },
  };
}

export { createNoObjectShapeCastFromUnknownRule };

/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/strict-boolean-expressions, eslint(max-lines-per-function), unicorn/no-useless-undefined */

function getTypeboxCheckIdentifier(node) {
  if (
    node?.type !== "CallExpression" ||
    node.callee?.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.object?.type !== "Identifier" ||
    node.callee.object.name !== "Value" ||
    node.callee.property?.type !== "Identifier" ||
    node.callee.property.name !== "Check"
  ) {
    return undefined;
  }

  const valueArgument = node.arguments?.[1];
  return valueArgument?.type === "Identifier" ? valueArgument.name : undefined;
}

function getTypeboxCheckTestInfo(node) {
  const directIdentifier = getTypeboxCheckIdentifier(node);
  if (directIdentifier !== undefined) {
    return { identifier: directIdentifier, negated: false };
  }

  if (node?.type === "UnaryExpression" && node.operator === "!") {
    const negatedIdentifier = getTypeboxCheckIdentifier(node.argument);
    if (negatedIdentifier !== undefined) {
      return { identifier: negatedIdentifier, negated: true };
    }
  }

  return undefined;
}

function alwaysAborts(node) {
  if (!node) {
    return false;
  }

  if (
    node.type === "ReturnStatement" ||
    node.type === "ThrowStatement" ||
    node.type === "ContinueStatement" ||
    node.type === "BreakStatement"
  ) {
    return true;
  }

  if (node.type !== "BlockStatement") {
    return false;
  }

  return alwaysAborts(node.body.at(-1));
}

function createNoRedundantCheckAfterTypeboxRule() {
  return {
    meta: {
      type: "problem",
      docs: {
        description: "Disallow redundant runtime checks after successful TypeBox validation.",
      },
      schema: [],
    },
    createOnce(context) {
      const scopeStack = [];
      const branchValidatedIdentifiers = new WeakMap();

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
        return scopeStack.at(-1);
      }

      function applyBranchValidatedIdentifiers(node) {
        const branchIdentifiers = branchValidatedIdentifiers.get(node);
        if (!branchIdentifiers) {
          return;
        }

        for (const identifier of branchIdentifiers) {
          currentScope().add(identifier);
        }
      }

      function markBranchValidatedIdentifier(node, identifier) {
        if (!node || identifier === undefined) {
          return;
        }

        const existingIdentifiers = branchValidatedIdentifiers.get(node) ?? [];
        branchValidatedIdentifiers.set(node, [...existingIdentifiers, identifier]);
      }

      function rememberValidatedBranchIdentifiers(node) {
        const testInfo = getTypeboxCheckTestInfo(node.test);
        if (!testInfo) {
          return;
        }

        if (!testInfo.negated) {
          markBranchValidatedIdentifier(node.consequent, testInfo.identifier);
          return;
        }

        if (node.alternate) {
          markBranchValidatedIdentifier(node.alternate, testInfo.identifier);
        }
      }

      function rememberValidatedIdentifierAfterIf(node) {
        const testInfo = getTypeboxCheckTestInfo(node.test);
        if (!testInfo?.negated || !alwaysAborts(node.consequent)) {
          return;
        }

        currentScope().add(testInfo.identifier);
      }

      function isValidatedIdentifier(node) {
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

      function report(node, identifierName, reason, fix) {
        context.report({
          node,
          message: `\`${identifierName}\` was already validated by TypeBox earlier in this code path, so this extra runtime check is redundant. ${reason} Fix: trust the prior \`Value.Check(...)\` / \`Value.Parse(...)\` result and use the validated value directly. ${fix}`,
        });
      }

      return {
        Program() {
          enterScope();
        },
        "Program:exit"() {
          exitScope();
        },
        BlockStatement(node) {
          enterScope();
          applyBranchValidatedIdentifiers(node);
        },
        ReturnStatement(node) {
          applyBranchValidatedIdentifiers(node);
        },
        ThrowStatement(node) {
          applyBranchValidatedIdentifiers(node);
        },
        ContinueStatement(node) {
          applyBranchValidatedIdentifiers(node);
        },
        BreakStatement(node) {
          applyBranchValidatedIdentifiers(node);
        },
        ExpressionStatement(node) {
          applyBranchValidatedIdentifiers(node);
        },
        "BlockStatement:exit"() {
          exitScope();
        },
        FunctionDeclaration() {
          enterScope();
        },
        "FunctionDeclaration:exit"() {
          exitScope();
        },
        FunctionExpression() {
          enterScope();
        },
        "FunctionExpression:exit"() {
          exitScope();
        },
        ArrowFunctionExpression() {
          enterScope();
        },
        "ArrowFunctionExpression:exit"() {
          exitScope();
        },
        IfStatement(node) {
          rememberValidatedBranchIdentifiers(node);
        },
        "IfStatement:exit"(node) {
          rememberValidatedIdentifierAfterIf(node);
        },
        VariableDeclarator(node) {
          if (
            node.id?.type === "Identifier" &&
            node.init?.type === "CallExpression" &&
            node.init.callee?.type === "MemberExpression" &&
            !node.init.callee.computed &&
            node.init.callee.object?.type === "Identifier" &&
            node.init.callee.object.name === "Value" &&
            node.init.callee.property?.type === "Identifier" &&
            node.init.callee.property.name === "Parse"
          ) {
            currentScope().add(node.id.name);
          }
        },
        BinaryExpression(node) {
          if (node.operator !== "!==" && node.operator !== "===") {
            return;
          }

          if (
            node.left?.type === "UnaryExpression" &&
            node.left.operator === "typeof" &&
            isValidatedIdentifier(node.left.argument)
          ) {
            report(
              node,
              node.left.argument.name,
              "TypeBox already proved the object shape.",
              "If you still need a narrower derived type, derive it from the schema instead of probing it again.",
            );
            return;
          }

          if (
            isValidatedIdentifier(node.left) &&
            node.right?.type === "Literal" &&
            node.right.value === null
          ) {
            report(
              node,
              node.left.name,
              "TypeBox already ruled out invalid shapes for this validated object.",
              "If null is truly expected, widen schema first instead of re-checking after validation.",
            );
          }
        },
        CallExpression(node) {
          if (
            node.callee?.type === "MemberExpression" &&
            !node.callee.computed &&
            node.callee.object?.type === "Identifier" &&
            node.callee.object.name === "Array" &&
            node.callee.property?.type === "Identifier" &&
            node.callee.property.name === "isArray"
          ) {
            const argument = node.arguments?.[0];
            if (isValidatedIdentifier(argument)) {
              report(
                node,
                argument.name,
                "TypeBox already proved the validated value shape.",
                "Model array-ness in the schema and trust it here.",
              );
            }
          }
        },
      };
    },
  };
}

export { createNoRedundantCheckAfterTypeboxRule };

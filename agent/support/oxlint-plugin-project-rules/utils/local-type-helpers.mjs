/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/strict-boolean-expressions, unicorn/no-useless-undefined, unicorn/prefer-at, no-unneeded-ternary */
import {
  getPropertyName,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./ast-helpers.mjs";

function createLocalTypeTracker() {
  const aliasDeclarations = new Map();
  const scopeStack = [];

  function enterScope() {
    scopeStack.push(new Map());
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

  function registerProgram(programNode) {
    aliasDeclarations.clear();
    for (const statement of programNode.body ?? []) {
      if (statement?.type === "TSTypeAliasDeclaration") {
        aliasDeclarations.set(statement.id.name, statement.typeAnnotation);
      }
      if (statement?.type === "TSInterfaceDeclaration") {
        aliasDeclarations.set(statement.id.name, statement.body);
      }
    }
  }

  function registerIdentifierType(name, typeAnnotation) {
    if (typeof name !== "string" || !typeAnnotation) {
      return;
    }
    currentScope().set(name, typeAnnotation);
  }

  function registerVariableDeclarator(node) {
    if (!isIdentifier(node.id) || !node.id.typeAnnotation?.typeAnnotation) {
      return;
    }
    registerIdentifierType(node.id.name, node.id.typeAnnotation.typeAnnotation);
  }

  function registerFunctionParameters(node) {
    for (const parameter of node.params ?? []) {
      if (parameter?.type === "Identifier" && parameter.typeAnnotation?.typeAnnotation) {
        registerIdentifierType(parameter.name, parameter.typeAnnotation.typeAnnotation);
      }
    }
  }

  function lookupIdentifierType(name) {
    for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
      const value = scopeStack[index].get(name);
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  function getTypeSummaryForExpression(node) {
    const expression = unwrapExpression(node);
    if (!isIdentifier(expression)) {
      return undefined;
    }
    const typeAnnotation = lookupIdentifierType(expression.name);
    if (!typeAnnotation) {
      return undefined;
    }
    return summarizeTypeNode(typeAnnotation, aliasDeclarations, new Set());
  }

  return {
    enterScope,
    exitScope,
    getTypeSummaryForExpression,
    registerFunctionParameters,
    registerProgram,
    registerVariableDeclarator,
  };
}

function summarizeTypeNode(typeNode, aliasDeclarations, seenAliases) {
  if (!typeNode) {
    return { kind: "unsupported" };
  }

  switch (typeNode.type) {
    case "TSParenthesizedType":
      return summarizeTypeNode(typeNode.typeAnnotation, aliasDeclarations, seenAliases);
    case "TSStringKeyword":
      return { kind: "string" };
    case "TSNumberKeyword":
      return { kind: "number" };
    case "TSBooleanKeyword":
      return { kind: "boolean" };
    case "TSAnyKeyword":
      return { kind: "any" };
    case "TSUnknownKeyword":
      return { kind: "unknown" };
    case "TSArrayType":
    case "TSTupleType":
      return { kind: "array" };
    case "TSFunctionType":
      return { kind: "function" };
    case "TSLiteralType":
      if (typeof typeNode.literal?.value === "string") {
        return { kind: "string" };
      }
      if (typeof typeNode.literal?.value === "number") {
        return { kind: "number" };
      }
      if (typeof typeNode.literal?.value === "boolean") {
        return { kind: "boolean" };
      }
      return { kind: "unsupported" };
    case "TSTypeLiteral":
    case "TSInterfaceBody":
      return summarizeObjectMembers(
        typeNode.members ?? typeNode.body ?? [],
        aliasDeclarations,
        seenAliases,
      );
    case "TSTypeReference":
      return summarizeTypeReference(typeNode, aliasDeclarations, seenAliases);
    case "TSUnionType":
      return { kind: "union" };
    case "TSIntersectionType":
      return summarizeIntersection(typeNode.types ?? [], aliasDeclarations, seenAliases);
    default:
      return { kind: "unsupported" };
  }
}

function summarizeTypeReference(typeNode, aliasDeclarations, seenAliases) {
  if (typeNode.typeName?.type === "Identifier") {
    const name = typeNode.typeName.name;
    if (name === "Array") {
      return { kind: "array" };
    }
    if (name === "Record") {
      return { kind: "unsupported" };
    }
    if (seenAliases.has(name)) {
      return { kind: "unsupported" };
    }
    const declaration = aliasDeclarations.get(name);
    if (!declaration) {
      return { kind: "unsupported" };
    }
    seenAliases.add(name);
    const summary = summarizeTypeNode(declaration, aliasDeclarations, seenAliases);
    seenAliases.delete(name);
    return summary;
  }
  return { kind: "unsupported" };
}

function summarizeIntersection(types, aliasDeclarations, seenAliases) {
  const summaries = types.map((typeNode) =>
    summarizeTypeNode(typeNode, aliasDeclarations, seenAliases),
  );
  if (summaries.some((summary) => summary.kind !== "object")) {
    return { kind: "unsupported" };
  }
  const guaranteedProps = new Set();
  for (const summary of summaries) {
    for (const propertyName of summary.guaranteedProps) {
      guaranteedProps.add(propertyName);
    }
  }
  return { kind: "object", guaranteedProps, hasIndexSignature: false };
}

function summarizeObjectMembers(members, aliasDeclarations, seenAliases) {
  const guaranteedProps = new Set();
  let hasIndexSignature = false;

  for (const member of members) {
    if (member?.type === "TSIndexSignature") {
      hasIndexSignature = true;
      continue;
    }
    if (member?.type !== "TSPropertySignature") {
      continue;
    }
    if (member.optional || member.computed) {
      continue;
    }
    const propertyName = getPropertyName(member.key);
    if (!propertyName) {
      continue;
    }
    const propertySummary = summarizeTypeNode(
      member.typeAnnotation?.typeAnnotation,
      aliasDeclarations,
      seenAliases,
    );
    if (propertySummary.kind === "unsupported") {
      continue;
    }
    guaranteedProps.add(propertyName);
  }

  return { kind: "object", guaranteedProps, hasIndexSignature };
}

function isRedundantTypeofCheck(node, tracker) {
  if (node.operator !== "===" && node.operator !== "==") {
    return false;
  }
  const left = unwrapExpression(node.left);
  const right = unwrapExpression(node.right);
  if (left?.type !== "UnaryExpression" || left.operator !== "typeof" || !isStringLiteral(right)) {
    return false;
  }
  const summary = tracker.getTypeSummaryForExpression(left.argument);
  if (!summary) {
    return false;
  }
  return summary.kind === right.value;
}

function isRedundantArrayIsArrayCall(node, tracker) {
  if (
    node.callee?.type !== "MemberExpression" ||
    node.callee.computed ||
    !isIdentifier(node.callee.object, "Array") ||
    !isIdentifier(node.callee.property, "isArray")
  ) {
    return false;
  }
  const [argument] = node.arguments ?? [];
  const summary = tracker.getTypeSummaryForExpression(argument);
  return summary?.kind === "array";
}

function isRedundantInstanceofCheck(node, tracker) {
  if (node.operator !== "instanceof") {
    return false;
  }
  const leftSummary = tracker.getTypeSummaryForExpression(node.left);
  if (node.right?.type !== "Identifier" || !leftSummary) {
    return false;
  }
  if (node.right.name === "Error") {
    return leftSummary.kind === "error";
  }
  return leftSummary.kind === "unsupported" ? false : false;
}

function isRedundantInCheck(node, tracker) {
  if (node.operator !== "in") {
    return false;
  }
  const left = unwrapExpression(node.left);
  if (!isStringLiteral(left)) {
    return false;
  }
  const summary = tracker.getTypeSummaryForExpression(node.right);
  if (!summary || summary.kind !== "object" || summary.hasIndexSignature) {
    return false;
  }
  return summary.guaranteedProps.has(left.value);
}

export {
  createLocalTypeTracker,
  isRedundantArrayIsArrayCall,
  isRedundantInCheck,
  isRedundantInstanceofCheck,
  isRedundantTypeofCheck,
  summarizeTypeNode,
};

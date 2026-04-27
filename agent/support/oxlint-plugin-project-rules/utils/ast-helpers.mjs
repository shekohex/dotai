/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/strict-boolean-expressions, unicorn/no-useless-undefined */
function isIdentifier(node, name) {
  return node?.type === "Identifier" && (name === undefined || node.name === name);
}

function isStringLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string";
}

function getPropertyName(node) {
  if (!node) {
    return undefined;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
}

function isReflectCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    isIdentifier(node.callee.object, "Reflect") &&
    node.callee.property?.type === "Identifier"
  );
}

function isGlobalFetchCall(node) {
  if (node?.type !== "CallExpression") {
    return false;
  }
  if (isIdentifier(node.callee, "fetch")) {
    return true;
  }
  return (
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    isIdentifier(node.callee.property, "fetch") &&
    (isIdentifier(node.callee.object, "globalThis") || isIdentifier(node.callee.object, "window"))
  );
}

function unwrapExpression(node) {
  let current = node;
  while (current?.type === "ChainExpression") {
    current = current.expression;
  }
  return current;
}

export {
  getPropertyName,
  isGlobalFetchCall,
  isIdentifier,
  isReflectCall,
  isStringLiteral,
  unwrapExpression,
};

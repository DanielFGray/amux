import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const BANNED_NAMES = new Set(["JsonValue", "JsonValueSchema"]);

const MESSAGE =
  "Contract values get an owner-declared Schema; JSON text crosses boundaries as OwnerJsonText.";

function unwrap(type: ESTree.TSType): ESTree.TSType {
  return type.type === "TSParenthesizedType" ? unwrap(type.typeAnnotation) : type;
}

function isNullType(type: ESTree.TSType): boolean {
  const node = unwrap(type);
  return (
    node.type === "TSNullKeyword" ||
    (node.type === "TSLiteralType" &&
      node.literal.type === "Literal" &&
      node.literal.value === null)
  );
}

function typeReferenceName(type: ESTree.TSType): string | null {
  const node = unwrap(type);
  if (node.type !== "TSTypeReference" || node.typeName.type !== "Identifier") return null;
  return node.typeName.name;
}

function isSelfReference(type: ESTree.TSType, aliasName: string): boolean {
  return typeReferenceName(type) === aliasName;
}

function isReadonlyArrayOfSelf(type: ESTree.TSType, aliasName: string): boolean {
  const node = unwrap(type);
  if (node.type === "TSArrayType") return isSelfReference(node.elementType, aliasName);
  if (node.type === "TSTypeOperator" && node.operator === "readonly") {
    return isReadonlyArrayOfSelf(node.typeAnnotation, aliasName);
  }
  return false;
}

function isRecordOfSelf(type: ESTree.TSType, aliasName: string): boolean {
  const node = unwrap(type);
  if (node.type === "TSTypeReference" && typeReferenceName(node) === "Record") {
    const params = node.typeArguments?.params ?? [];
    const [key, value] = params;
    if (key === undefined || value === undefined) return false;
    return unwrap(key).type === "TSStringKeyword" && isSelfReference(value, aliasName);
  }
  if (node.type !== "TSTypeLiteral") return false;
  const [member] = node.members;
  if (member === undefined || member.type !== "TSIndexSignature") return false;
  const [key] = member.parameters;
  if (
    key === undefined ||
    key.type !== "Identifier" ||
    key.typeAnnotation?.typeAnnotation.type !== "TSStringKeyword"
  ) {
    return false;
  }
  const value = member.typeAnnotation?.typeAnnotation;
  return value !== undefined && isSelfReference(value, aliasName);
}

function isJsonShapedRecursiveUnion(alias: ESTree.TSTypeAliasDeclaration): boolean {
  const annotation = unwrap(alias.typeAnnotation);
  if (annotation.type !== "TSUnionType") return false;

  let hasString = false;
  let hasNumber = false;
  let hasBoolean = false;
  let hasNull = false;
  let hasArray = false;
  let hasRecord = false;

  for (const member of annotation.types) {
    const node = unwrap(member);
    if (node.type === "TSStringKeyword") {
      hasString = true;
      continue;
    }
    if (node.type === "TSNumberKeyword") {
      hasNumber = true;
      continue;
    }
    if (node.type === "TSBooleanKeyword") {
      hasBoolean = true;
      continue;
    }
    if (isNullType(node)) {
      hasNull = true;
      continue;
    }
    if (isReadonlyArrayOfSelf(node, alias.id.name)) {
      hasArray = true;
      continue;
    }
    if (isRecordOfSelf(node, alias.id.name)) {
      hasRecord = true;
      continue;
    }
    return false;
  }

  return hasString && hasNumber && hasBoolean && hasNull && hasArray && hasRecord;
}

function declaredStatement(statement: ESTree.Statement): ESTree.Node | null {
  return statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration"
    ? (statement.declaration ?? null)
    : statement;
}

function isEstreeNode(value: unknown): value is ESTree.Node {
  return value !== null && typeof value === "object" && "type" in value;
}

function forEachChild(node: ESTree.Node, visit: (child: ESTree.Node) => void): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || value === null || value === undefined || typeof value !== "object") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isEstreeNode(item)) visit(item);
      }
      continue;
    }
    if (isEstreeNode(value)) visit(value);
  }
}

function callPropertyName(node: ESTree.CallExpression): string | null {
  if (node.callee.type !== "MemberExpression" || node.callee.computed) return null;
  if (node.callee.property.type !== "Identifier") return null;
  return node.callee.property.name;
}

function identifierName(
  arg: ESTree.CallExpression["arguments"][number] | null | undefined,
): string | null {
  if (arg === null || arg === undefined || arg.type !== "Identifier") return null;
  return arg.name;
}

function isStringSchemaArg(
  arg: ESTree.CallExpression["arguments"][number] | null | undefined,
): boolean {
  if (arg === null || arg === undefined || arg.type !== "MemberExpression" || arg.computed) {
    return false;
  }
  return arg.property.type === "Identifier" && arg.property.name === "String";
}

/**
 * A Schema const whose initializer is S.suspend(() => S.Union([...])) (or the
 * same shape without suspend) containing both Array(<own name>) and
 * Record(<string schema>, <own name>) — the old JsonValueSchema body renamed.
 */
function isRecursiveJsonSchema(init: ESTree.Expression, name: string): boolean {
  let found = false;

  const visit = (node: ESTree.Node): void => {
    if (node.type === "CallExpression" && callPropertyName(node) === "Union") {
      const [members] = node.arguments;
      if (members !== undefined && members.type === "ArrayExpression") {
        let hasArrayOfSelf = false;
        let hasRecordOfSelf = false;
        for (const element of members.elements) {
          if (element === null || element.type !== "CallExpression") continue;
          const property = callPropertyName(element);
          if (property === "Array") {
            const [item] = element.arguments;
            if (identifierName(item) === name) hasArrayOfSelf = true;
          }
          if (property === "Record") {
            const [key, value] = element.arguments;
            if (isStringSchemaArg(key) && identifierName(value) === name) {
              hasRecordOfSelf = true;
            }
          }
        }
        if (hasArrayOfSelf && hasRecordOfSelf) found = true;
      }
    }
    forEachChild(node, visit);
  };

  visit(init);
  return found;
}

/** Ban JsonValue / JsonValueSchema and recursive open JSON bag aliases under any name. */
export const noJsonValueTypeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow JsonValue / JsonValueSchema names and recursive JSON-shaped union aliases or Schema consts; owner Schemas and OwnerJsonText replace the open JSON bag.",
    },
    messages: {
      jsonValueBag: MESSAGE,
    },
  },
  create(context) {
    const report = (node: ESTree.Node) => {
      context.report({ node, messageId: "jsonValueBag" });
    };

    return {
      Program(program) {
        for (const statement of program.body) {
          const declaration = declaredStatement(statement);
          if (declaration?.type === "TSTypeAliasDeclaration") {
            if (BANNED_NAMES.has(declaration.id.name) || isJsonShapedRecursiveUnion(declaration)) {
              report(declaration.id);
            }
            continue;
          }
          if (declaration?.type === "TSInterfaceDeclaration") {
            if (BANNED_NAMES.has(declaration.id.name)) report(declaration.id);
            continue;
          }
          if (declaration?.type === "VariableDeclaration") {
            for (const declarator of declaration.declarations) {
              if (declarator.id.type !== "Identifier") continue;
              if (declarator.init === null || declarator.init === undefined) continue;
              if (
                BANNED_NAMES.has(declarator.id.name) ||
                isRecursiveJsonSchema(declarator.init, declarator.id.name)
              ) {
                report(declarator.id);
              }
            }
          }
        }
      },
    };
  },
});

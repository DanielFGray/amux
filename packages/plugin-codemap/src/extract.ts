/**
 * Tree-sitter TS/TSX/JS extractor with Effect-aware wrappers and DI edges.
 *
 * Borrows calldiff's wrapper unwrapping (fnUntraced / gen / defineX) and Graft's
 * path#symbol id shape. Walks StructureNode from @danielfgray/amux-vim —
 * no second grammar loader.
 */
import { Option } from "effect";
import type { StructureNode, StructureTree } from "@danielfgray/amux-vim";
import type { CodemapEdge, CodemapImport, CodemapSymbol, FileExtraction, Span } from "./schema.ts";

const FN_LIKE = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
]);

const TRANSPARENT = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
  "type_assertion",
]);

const namedChildren = (node: StructureNode): ReadonlyArray<StructureNode> => {
  const out: StructureNode[] = [];
  for (let i = 0; ; i++) {
    const child = node.namedChild(i);
    if (child === null) return out;
    out.push(child);
  }
};

/** Pair / declarator value: first named child that is not the key / name. */
const valueAfter = (node: StructureNode, key: StructureNode): Option.Option<StructureNode> => {
  for (const child of namedChildren(node)) {
    if (child.id === key.id) continue;
    return Option.some(child);
  }
  return Option.none();
};

const childByType = (node: StructureNode, type: string): Option.Option<StructureNode> => {
  for (const child of namedChildren(node)) {
    if (child.type === type) return Option.some(child);
  }
  return Option.none();
};

const spanOf = (node: StructureNode): Span => ({
  startLine: node.start.row,
  startCol: node.start.col,
  endLine: node.end.row,
  endCol: node.end.col,
});

const stripWrappers = (node: StructureNode): StructureNode => {
  let current = node;
  while (TRANSPARENT.has(current.type)) {
    const inner = namedChildren(current).find((c) => c.type !== "type_arguments");
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
};

const isExported = (node: StructureNode): boolean => {
  for (const a of node.ancestors()) {
    if (a.type === "export_statement") return true;
    if (a.type === "program") return false;
  }
  return false;
};

const bodyOf = (fn: StructureNode): Option.Option<StructureNode> => {
  const block = childByType(fn, "statement_block");
  if (Option.isSome(block)) return block;
  // arrow expression body — last non-param named child
  if (fn.type === "arrow_function") {
    const kids = namedChildren(fn);
    const body = kids.find(
      (c) =>
        c.type !== "formal_parameters" &&
        c.type !== "type_parameters" &&
        c.type !== "type_annotation" &&
        c.type !== "async",
    );
    return body === undefined ? Option.none() : Option.some(body);
  }
  return Option.none();
};

const calleeKey = (node: StructureNode): Option.Option<string> => {
  if (node.type === "identifier") return Option.some(node.text);
  if (node.type === "member_expression") {
    const object = node.namedChild(0);
    const property = namedChildren(node).find(
      (c) => c.type === "property_identifier" || c.type === "private_property_identifier",
    );
    if (object === null || property === undefined) return Option.none();
    if (object.type === "identifier") {
      return Option.some(`${object.text}.${property.text}`);
    }
    return Option.some(property.text);
  }
  return Option.none();
};

const memberParts = (
  node: StructureNode,
): Option.Option<{ readonly object: string; readonly property: string }> => {
  if (node.type !== "member_expression") return Option.none();
  const object = node.namedChild(0);
  const property = namedChildren(node).find(
    (c) => c.type === "property_identifier" || c.type === "private_property_identifier",
  );
  if (object === null || object.type !== "identifier" || property === undefined) {
    return Option.none();
  }
  return Option.some({ object: object.text, property: property.text });
};

type DiBindings = ReadonlyMap<string, string>;

type ExtractState = {
  readonly path: string;
  symbols: CodemapSymbol[];
  imports: CodemapImport[];
  edges: CodemapEdge[];
  seenSymbol: Set<string>;
};

const symbolId = (path: string, name: string, owner: string | undefined): string => {
  if (owner !== undefined) return `${path}#${owner}.${name}`;
  return `${path}#${name}`;
};

const pushSymbol = (state: ExtractState, symbol: CodemapSymbol): void => {
  if (state.seenSymbol.has(symbol.id)) return;
  state.seenSymbol.add(symbol.id);
  state.symbols.push(symbol);
};

const pushContains = (state: ExtractState, ownerId: string, childId: string): void => {
  state.edges.push({
    source: ownerId,
    target: childId,
    relation: "contains",
    confidence: "extracted",
  });
};

const pushCall = (
  state: ExtractState,
  callerId: string,
  target: string,
  span: Span,
  di: boolean,
): void => {
  if (di) {
    state.edges.push({
      source: callerId,
      target,
      relation: "calls",
      confidence: "inferred",
      span,
      di: true,
    });
    return;
  }
  state.edges.push({
    source: callerId,
    target,
    relation: "calls",
    confidence: "extracted",
    span,
  });
};

/**
 * Peel `wrapper(fn)` / `wrapper(wrapper(fn))` — Effect.fnUntraced, Effect.gen, etc.
 * Returns the innermost function-like argument when present.
 */
const unwrapWrappedFunction = (call: StructureNode): Option.Option<StructureNode> => {
  const args = childByType(call, "arguments");
  if (Option.isNone(args)) return Option.none();
  for (const raw of namedChildren(args.value)) {
    const arg = stripWrappers(raw);
    if (arg.type === "call_expression") {
      const nested = unwrapWrappedFunction(arg);
      if (Option.isSome(nested)) return nested;
      continue;
    }
    if (FN_LIKE.has(arg.type)) return Option.some(arg);
  }
  return Option.none();
};

const functionFromInit = (init: StructureNode): Option.Option<StructureNode> => {
  const stripped = stripWrappers(init);
  if (FN_LIKE.has(stripped.type)) return Option.some(stripped);
  if (stripped.type === "call_expression") return unwrapWrappedFunction(stripped);
  return Option.none();
};

const declaratorName = (declarator: StructureNode): Option.Option<string> => {
  const id = childByType(declarator, "identifier");
  return Option.map(id, (n) => n.text);
};

const declaratorInit = (declarator: StructureNode): Option.Option<StructureNode> => {
  for (const child of namedChildren(declarator)) {
    if (child.type === "identifier") continue;
    if (child.type === "type_annotation") continue;
    if (child.type === "array_pattern" || child.type === "object_pattern") continue;
    return Option.some(child);
  }
  return Option.none();
};

const yieldServiceName = (yieldNode: StructureNode): Option.Option<string> => {
  if (yieldNode.type !== "yield_expression") return Option.none();
  if (!yieldNode.text.startsWith("yield*")) return Option.none();
  for (const child of namedChildren(yieldNode)) {
    if (child.type === "identifier") return Option.some(child.text);
    if (child.type === "call_expression") {
      // yield* Service.method(...) is a call, not a DI bind
      return Option.none();
    }
  }
  return Option.none();
};

/** `Context.get(ctx, Service)` → Service */
const contextGetService = (call: StructureNode): Option.Option<string> => {
  const callee = call.namedChild(0);
  if (callee === null) return Option.none();
  const parts = memberParts(callee);
  if (Option.isNone(parts)) return Option.none();
  if (parts.value.object !== "Context" || parts.value.property !== "get") {
    return Option.none();
  }
  const args = childByType(call, "arguments");
  if (Option.isNone(args)) return Option.none();
  const kids = namedChildren(args.value);
  const service = kids[1];
  if (service === undefined || service.type !== "identifier") return Option.none();
  return Option.some(service.text);
};

const isContextServiceClass = (classNode: StructureNode): boolean => {
  const heritage = childByType(classNode, "class_heritage");
  if (Option.isNone(heritage)) return false;
  return heritage.value.text.includes("Context.Service");
};

const findMakeBody = (classNode: StructureNode): Option.Option<StructureNode> => {
  const heritage = childByType(classNode, "class_heritage");
  if (Option.isNone(heritage)) return Option.none();
  const findPair = (node: StructureNode): Option.Option<StructureNode> => {
    if (node.type === "pair") {
      const key = node.namedChild(0);
      if (key !== null && key.text === "make") {
        const value = valueAfter(node, key);
        if (Option.isNone(value)) return Option.none();
        const fn = functionFromInit(value.value);
        if (Option.isSome(fn)) return bodyOf(fn.value);
        return bodyOf(value.value);
      }
    }
    for (const child of namedChildren(node)) {
      const hit = findPair(child);
      if (Option.isSome(hit)) return hit;
    }
    return Option.none();
  };
  return findPair(heritage.value);
};

const collectObjectMethods = (
  state: ExtractState,
  objectNode: StructureNode,
  owner: string,
  ownerId: string,
  exported: boolean,
  bindings: DiBindings,
): void => {
  for (const child of namedChildren(objectNode)) {
    if (child.type !== "pair") continue;
    const key = child.namedChild(0);
    if (key === null) continue;
    if (key.type !== "property_identifier" && key.type !== "identifier") continue;
    const valueOpt = valueAfter(child, key);
    if (Option.isNone(valueOpt)) continue;
    const value = valueOpt.value;
    const fn = functionFromInit(value);
    if (Option.isNone(fn)) continue;
    const name = key.text;
    const id = symbolId(state.path, name, owner);
    pushSymbol(state, {
      id,
      name,
      kind: "method",
      span: spanOf(child),
      exported,
      owner,
      local: true,
    });
    pushContains(state, ownerId, id);
    walkBody(state, fn.value, id, bindings);
  }
};

const registerFunctionSymbol = (
  state: ExtractState,
  name: string,
  fnNode: StructureNode,
  spanNode: StructureNode,
  opts: {
    readonly kind: "function" | "method" | "const";
    readonly exported: boolean;
    readonly owner: string | undefined;
    readonly local: boolean;
    readonly parentId: string | undefined;
    readonly bindings: DiBindings;
  },
): string => {
  const id = symbolId(state.path, name, opts.owner);
  if (opts.owner !== undefined && opts.local) {
    pushSymbol(state, {
      id,
      name,
      kind: opts.kind,
      span: spanOf(spanNode),
      exported: opts.exported,
      owner: opts.owner,
      local: true,
    });
  } else if (opts.owner !== undefined) {
    pushSymbol(state, {
      id,
      name,
      kind: opts.kind,
      span: spanOf(spanNode),
      exported: opts.exported,
      owner: opts.owner,
    });
  } else if (opts.local) {
    pushSymbol(state, {
      id,
      name,
      kind: opts.kind,
      span: spanOf(spanNode),
      exported: opts.exported,
      local: true,
    });
  } else {
    pushSymbol(state, {
      id,
      name,
      kind: opts.kind,
      span: spanOf(spanNode),
      exported: opts.exported,
    });
  }
  if (opts.parentId !== undefined) {
    pushContains(state, opts.parentId, id);
  }
  walkBody(state, fnNode, id, opts.bindings);
  return id;
};

const scanReturnedObjectMethods = (
  state: ExtractState,
  body: StructureNode,
  owner: string,
  ownerId: string,
  exported: boolean,
  bindings: DiBindings,
): void => {
  const visit = (node: StructureNode): void => {
    if (node.type === "return_statement") {
      for (const child of namedChildren(node)) {
        const stripped = stripWrappers(child);
        if (stripped.type === "object") {
          collectObjectMethods(state, stripped, owner, ownerId, exported, bindings);
        }
      }
      return;
    }
    if (FN_LIKE.has(node.type)) return;
    for (const child of namedChildren(node)) visit(child);
  };
  const stripped = stripWrappers(body);
  if (stripped.type === "object") {
    collectObjectMethods(state, stripped, owner, ownerId, exported, bindings);
    return;
  }
  visit(body);
};

const walkBody = (
  state: ExtractState,
  fnOrBody: StructureNode,
  callerId: string,
  parentBindings: DiBindings,
): void => {
  const bindings = new Map(parentBindings);
  const body = FN_LIKE.has(fnOrBody.type)
    ? Option.getOrElse(bodyOf(fnOrBody), () => fnOrBody)
    : fnOrBody;

  // Object-literal service methods on the returning function
  const callerSym = state.symbols.find((s) => s.id === callerId);
  if (callerSym !== undefined && (callerSym.kind === "function" || callerSym.kind === "const")) {
    scanReturnedObjectMethods(state, body, callerSym.name, callerId, callerSym.exported, bindings);
  }

  const visit = (node: StructureNode): void => {
    // Nested function declarations
    if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
      const idNode = childByType(node, "identifier");
      if (Option.isSome(idNode)) {
        registerFunctionSymbol(state, idNode.value.text, node, node, {
          kind: "function",
          exported: false,
          owner: callerSym?.name,
          local: true,
          parentId: callerId,
          bindings,
        });
      }
      return;
    }

    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const d of namedChildren(node)) {
        if (d.type !== "variable_declarator") continue;
        const nameOpt = declaratorName(d);
        const initOpt = declaratorInit(d);
        if (Option.isNone(nameOpt) || Option.isNone(initOpt)) continue;
        const name = nameOpt.value;
        const init = stripWrappers(initOpt.value);

        // DI bind: const x = yield* Service
        if (init.type === "yield_expression") {
          const service = yieldServiceName(init);
          if (Option.isSome(service)) {
            bindings.set(name, service.value);
          }
        }

        // DI bind: const x = Context.get(ctx, Service)
        if (init.type === "call_expression") {
          const service = contextGetService(init);
          if (Option.isSome(service)) {
            bindings.set(name, service.value);
          }
        }

        const fn = functionFromInit(init);
        if (Option.isSome(fn)) {
          registerFunctionSymbol(state, name, fn.value, d, {
            kind: "const",
            exported: false,
            owner: callerSym?.name,
            local: true,
            parentId: callerId,
            bindings,
          });
          continue;
        }
      }
      // Still walk inits for calls that are not function defs
      for (const d of namedChildren(node)) {
        if (d.type !== "variable_declarator") continue;
        const initOpt = declaratorInit(d);
        if (Option.isNone(initOpt)) continue;
        const init = stripWrappers(initOpt.value);
        if (FN_LIKE.has(init.type)) continue;
        if (init.type === "call_expression" && Option.isSome(functionFromInit(init))) continue;
        visit(init);
      }
      return;
    }

    if (node.type === "return_statement") {
      for (const child of namedChildren(node)) {
        const stripped = stripWrappers(child);
        // Object-literal methods already registered via scanReturnedObjectMethods.
        if (stripped.type === "object") continue;
        visit(stripped);
      }
      return;
    }

    if (node.type === "call_expression") {
      const callee = node.namedChild(0);
      if (callee !== null) {
        const parts = memberParts(callee);
        if (Option.isSome(parts)) {
          const service = bindings.get(parts.value.object);
          if (service !== undefined) {
            pushCall(state, callerId, `${service}.${parts.value.property}`, spanOf(node), true);
          } else {
            const key = calleeKey(callee);
            if (Option.isSome(key)) {
              pushCall(state, callerId, key.value, spanOf(node), false);
            }
          }
        } else {
          const key = calleeKey(callee);
          if (Option.isSome(key)) {
            pushCall(state, callerId, key.value, spanOf(node), false);
          }
        }
        // `loadPluginsEffect(...).pipe(...)` — the left call is the member object.
        if (callee.type === "member_expression") {
          const object = callee.namedChild(0);
          if (object !== null) visit(object);
        }
      }
      // Descend into arguments (pipe / match callbacks).
      const args = childByType(node, "arguments");
      if (Option.isSome(args)) {
        for (const arg of namedChildren(args.value)) {
          const stripped = stripWrappers(arg);
          if (FN_LIKE.has(stripped.type)) {
            walkCallback(state, stripped, callerId, bindings, callerSym?.name);
            continue;
          }
          if (stripped.type === "call_expression") {
            Option.match(unwrapWrappedFunction(stripped), {
              onNone: () => visit(stripped),
              onSome: (inner) => walkCallback(state, inner, callerId, bindings, callerSym?.name),
            });
            continue;
          }
          visit(stripped);
        }
      }
      return;
    }

    if (node.type === "yield_expression") {
      for (const child of namedChildren(node)) visit(child);
      return;
    }

    if (FN_LIKE.has(node.type)) {
      walkCallback(state, node, callerId, bindings, callerSym?.name);
      return;
    }

    for (const child of namedChildren(node)) visit(child);
  };

  visit(body);
};

/** Walk a callback without creating a symbol — calls stay on the outer caller. */
const walkCallback = (
  state: ExtractState,
  fn: StructureNode,
  callerId: string,
  parentBindings: DiBindings,
  ownerName: string | undefined,
): void => {
  const bindings = new Map(parentBindings);
  const body = Option.getOrElse(bodyOf(fn), () => fn);

  const visit = (node: StructureNode): void => {
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const d of namedChildren(node)) {
        if (d.type !== "variable_declarator") continue;
        const nameOpt = declaratorName(d);
        const initOpt = declaratorInit(d);
        if (Option.isNone(nameOpt) || Option.isNone(initOpt)) continue;
        const init = stripWrappers(initOpt.value);
        if (init.type === "yield_expression") {
          const service = yieldServiceName(init);
          if (Option.isSome(service)) bindings.set(nameOpt.value, service.value);
        }
        if (init.type === "call_expression") {
          const service = contextGetService(init);
          if (Option.isSome(service)) bindings.set(nameOpt.value, service.value);
        }
        const fnInit = functionFromInit(init);
        if (Option.isSome(fnInit)) {
          registerFunctionSymbol(state, nameOpt.value, fnInit.value, d, {
            kind: "const",
            exported: false,
            owner: ownerName,
            local: true,
            parentId: callerId,
            bindings,
          });
          continue;
        }
        visit(init);
      }
      return;
    }

    if (node.type === "call_expression") {
      const callee = node.namedChild(0);
      if (callee !== null) {
        const parts = memberParts(callee);
        if (Option.isSome(parts)) {
          const service = bindings.get(parts.value.object);
          if (service !== undefined) {
            pushCall(state, callerId, `${service}.${parts.value.property}`, spanOf(node), true);
          } else {
            const key = calleeKey(callee);
            if (Option.isSome(key)) {
              pushCall(state, callerId, key.value, spanOf(node), false);
            }
          }
        } else {
          const key = calleeKey(callee);
          if (Option.isSome(key)) {
            pushCall(state, callerId, key.value, spanOf(node), false);
          }
        }
        if (callee.type === "member_expression") {
          const object = callee.namedChild(0);
          if (object !== null) visit(object);
        }
      }
      const args = childByType(node, "arguments");
      if (Option.isSome(args)) {
        for (const arg of namedChildren(args.value)) {
          const stripped = stripWrappers(arg);
          if (FN_LIKE.has(stripped.type)) {
            walkCallback(state, stripped, callerId, bindings, ownerName);
          } else {
            visit(stripped);
          }
        }
      }
      return;
    }

    if (FN_LIKE.has(node.type)) {
      walkCallback(state, node, callerId, bindings, ownerName);
      return;
    }

    for (const child of namedChildren(node)) visit(child);
  };

  visit(body);
};

const handleImport = (state: ExtractState, node: StructureNode): void => {
  const sourceNode = childByType(node, "string");
  if (Option.isNone(sourceNode)) return;
  const source = sourceNode.value.text.slice(1, -1);
  const specifiers: { local: string; imported?: string }[] = [];

  const clause = childByType(node, "import_clause");
  if (Option.isSome(clause)) {
    for (const part of namedChildren(clause.value)) {
      if (part.type === "identifier") {
        specifiers.push({ local: part.text, imported: "default" });
      } else if (part.type === "namespace_import") {
        const id = childByType(part, "identifier");
        if (Option.isSome(id)) {
          specifiers.push({ local: id.value.text, imported: "*" });
        }
      } else if (part.type === "named_imports") {
        for (const spec of namedChildren(part)) {
          if (spec.type !== "import_specifier") continue;
          const kids = namedChildren(spec);
          const first = kids[0];
          const second = kids[1];
          if (first === undefined) continue;
          if (second !== undefined) {
            specifiers.push({ local: second.text, imported: first.text });
          } else {
            specifiers.push({ local: first.text });
          }
        }
      }
    }
  }

  state.imports.push({ source, specifiers, span: spanOf(node) });
  state.edges.push({
    source: state.path,
    target: source,
    relation: "imports",
    confidence: "extracted",
    span: spanOf(node),
  });
};

const handleClass = (state: ExtractState, node: StructureNode, exported: boolean): void => {
  const nameNode = Option.orElse(childByType(node, "type_identifier"), () =>
    childByType(node, "identifier"),
  );
  if (Option.isNone(nameNode)) return;
  const className = nameNode.value.text;
  const classId = symbolId(state.path, className, undefined);
  pushSymbol(state, {
    id: classId,
    name: className,
    kind: "class",
    span: spanOf(node),
    exported,
  });

  const emptyBindings: DiBindings = new Map();

  if (isContextServiceClass(node)) {
    const makeBody = findMakeBody(node);
    if (Option.isSome(makeBody)) {
      // Nested consts in make become Owner.method symbols
      const visitMake = (n: StructureNode): void => {
        if (n.type === "lexical_declaration" || n.type === "variable_declaration") {
          for (const d of namedChildren(n)) {
            if (d.type !== "variable_declarator") continue;
            const nameOpt = declaratorName(d);
            const initOpt = declaratorInit(d);
            if (Option.isNone(nameOpt) || Option.isNone(initOpt)) continue;
            const fn = functionFromInit(initOpt.value);
            if (Option.isNone(fn)) {
              // plain const function assignment: const run = ( =>
              const stripped = stripWrappers(initOpt.value);
              if (
                stripped.type === "arrow_function" ||
                stripped.type === "function_expression" ||
                stripped.type === "generator_function"
              ) {
                registerFunctionSymbol(state, nameOpt.value, stripped, d, {
                  kind: "method",
                  exported,
                  owner: className,
                  local: false,
                  parentId: classId,
                  bindings: emptyBindings,
                });
              }
              continue;
            }
            registerFunctionSymbol(state, nameOpt.value, fn.value, d, {
              kind: "method",
              exported,
              owner: className,
              local: false,
              parentId: classId,
              bindings: emptyBindings,
            });
          }
          return;
        }
        if (FN_LIKE.has(n.type)) return;
        for (const child of namedChildren(n)) visitMake(child);
      };
      visitMake(makeBody.value);
    }
  }

  const classBody = childByType(node, "class_body");
  if (Option.isNone(classBody)) return;
  for (const element of namedChildren(classBody.value)) {
    if (element.type === "method_definition") {
      const keyNode = namedChildren(element).find(
        (c) =>
          c.type === "property_identifier" ||
          c.type === "private_property_identifier" ||
          c.type === "computed_property_name",
      );
      if (keyNode === undefined) continue;
      registerFunctionSymbol(state, keyNode.text, element, element, {
        kind: "method",
        exported,
        owner: className,
        local: false,
        parentId: classId,
        bindings: emptyBindings,
      });
    }
  }
};

const handleStatement = (state: ExtractState, node: StructureNode, exported: boolean): void => {
  if (node.type === "import_statement") {
    handleImport(state, node);
    return;
  }

  if (node.type === "export_statement") {
    for (const child of namedChildren(node)) {
      if (child.type === "string") continue;
      handleStatement(state, child, true);
    }
    return;
  }

  if (node.type === "expression_statement") {
    const scriptId = `${state.path}#(script)`;
    if (!state.seenSymbol.has(scriptId)) {
      pushSymbol(state, {
        id: scriptId,
        name: "(script)",
        kind: "function",
        span: spanOf(node),
        exported: false,
        local: true,
      });
    }
    // testEffect(() => Effect.gen(...)) and similar top-level calls
    for (const child of namedChildren(node)) {
      walkCallback(state, child, scriptId, new Map(), undefined);
    }
    return;
  }

  if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
    const idNode = childByType(node, "identifier");
    if (Option.isNone(idNode)) return;
    registerFunctionSymbol(state, idNode.value.text, node, node, {
      kind: "function",
      exported: exported || isExported(node),
      owner: undefined,
      local: false,
      parentId: undefined,
      bindings: new Map(),
    });
    return;
  }

  if (node.type === "class_declaration") {
    handleClass(state, node, exported || isExported(node));
    return;
  }

  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    for (const d of namedChildren(node)) {
      if (d.type !== "variable_declarator") continue;
      const nameOpt = declaratorName(d);
      const initOpt = declaratorInit(d);
      if (Option.isNone(nameOpt) || Option.isNone(initOpt)) continue;
      const fn = functionFromInit(initOpt.value);
      if (Option.isNone(fn)) continue;
      registerFunctionSymbol(state, nameOpt.value, fn.value, d, {
        kind: "const",
        exported: exported || isExported(d),
        owner: undefined,
        local: false,
        parentId: undefined,
        bindings: new Map(),
      });
    }
  }
};

/** Pure extraction from an already-parsed StructureTree. Caller deletes the tree. */
export const extractFromTree = (path: string, tree: StructureTree): FileExtraction => {
  const state: ExtractState = {
    path,
    symbols: [],
    imports: [],
    edges: [],
    seenSymbol: new Set(),
  };

  for (const child of namedChildren(tree.root)) {
    handleStatement(state, child, false);
  }

  return {
    path,
    symbols: state.symbols,
    imports: state.imports,
    edges: state.edges,
  };
};

export const filetypeForExtractPath = (filePath: string): Option.Option<string> => {
  if (filePath.endsWith(".tsx")) return Option.some("typescriptreact");
  if (filePath.endsWith(".ts")) return Option.some("typescript");
  if (filePath.endsWith(".jsx")) return Option.some("javascriptreact");
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return Option.some("javascript");
  }
  return Option.none();
};

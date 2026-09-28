function normalizePath(path) {
  return path.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
}

function normalizeModuleName(moduleName) {
  return moduleName.replace(/^\.\//, "");
}

function addImportBindings(bindings, clause, moduleName, kind) {
  moduleName = normalizeModuleName(moduleName);
  const normalizedClause = clause.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").trim();
  if (!normalizedClause) return;

  if (normalizedClause.startsWith("{")) {
    const namedBindings = normalizedClause.slice(1, normalizedClause.lastIndexOf("}"));
    for (const binding of namedBindings.split(",")) {
      const parts = binding.trim().split(/\s+as\s+/);
      const importedName = parts[0]?.trim();
      const localName = parts[1]?.trim() || importedName;
      if (!importedName || !localName || importedName === "type") continue;
      bindings.set(localName, { moduleName, kind });
    }
    return;
  }

  if (normalizedClause.startsWith("*")) {
    const namespaceName = normalizedClause.match(/^\*\s+as\s+(\w+)$/)?.[1];
    if (namespaceName) bindings.set(namespaceName, { moduleName, kind: "namespace" });
    return;
  }

  const defaultName = normalizedClause.split(",")[0]?.trim();
  if (defaultName && /^\w+$/.test(defaultName)) {
    bindings.set(defaultName, { moduleName, kind });
  }
}

function parseImports(source) {
  const bindings = new Map();
  const importPattern = /\bimport\s+(?!type\b)([^;]*?)\s+from\s+["'](\.\/[^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    addImportBindings(bindings, match[1], match[2], "import");
  }

  const reExportPattern = /\bexport\s+\{([\s\S]*?)\}\s+from\s+["'](\.\/[^"']+)["']/g;
  for (const match of source.matchAll(reExportPattern)) {
    addImportBindings(bindings, `{${match[1]}}`, match[2], "re-export");
  }

  return bindings;
}

function parseReExportedModules(source) {
  const modules = new Set();
  const reExportPattern =
    /\bexport\s+(?:\{[\s\S]*?\}|\*\s*(?:as\s+\w+)?)[ \t]+from\s+["'](\.\/[^"']+)["']/g;
  for (const match of source.matchAll(reExportPattern)) {
    modules.add(normalizeModuleName(match[1]));
  }
  return modules;
}

function parseLiteralPath(value) {
  const match = value.match(/^(['"])([^'"]*)\1$/);
  if (match) return match[2];
  const templateMatch = value.match(/^`([^`${}]*)`$/);
  return templateMatch?.[1];
}

function findCallEnd(source, openParenIndex) {
  let depth = 1;
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openParenIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")" && --depth === 0) return index;
  }

  throw new Error(`Unclosed router call at character ${openParenIndex}`);
}

function splitTopLevelArguments(source) {
  const argumentsList = [];
  let start = 0;
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;
  let quote;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") parentheses += 1;
    if (character === ")") parentheses -= 1;
    if (character === "{") braces += 1;
    if (character === "}") braces -= 1;
    if (character === "[") brackets += 1;
    if (character === "]") brackets -= 1;
    if (character === "," && parentheses === 0 && braces === 0 && brackets === 0) {
      argumentsList.push(source.slice(start, index));
      start = index + 1;
    }
  }

  if (source.slice(start).trim()) argumentsList.push(source.slice(start));
  return argumentsList;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim();
}

function parseRouteMounts(source, mount) {
  const imports = parseImports(source);
  const mounts = [];
  const usePattern = /router\.use\s*\(/g;

  for (const match of source.matchAll(usePattern)) {
    const openParenIndex = (match.index ?? 0) + match[0].lastIndexOf("(");
    const closeParenIndex = findCallEnd(source, openParenIndex);
    const argumentsList = splitTopLevelArguments(
      source.slice(openParenIndex + 1, closeParenIndex),
    ).map(stripComments);
    if (argumentsList.length > 2) {
      throw new Error(
        `Unsupported route mount arguments: ${argumentsList.join(", ")}`,
      );
    }
    const moduleReference = argumentsList.at(-1);
    if (!moduleReference) {
      throw new Error("Unsupported route mount with no middleware or router target");
    }
    if (!/^\w+$/.test(moduleReference)) {
      if (argumentsList.length > 1) {
        throw new Error(
          `Unsupported route mount target ${moduleReference}; expected an imported router identifier`,
        );
      }
      continue;
    }

    const binding = imports.get(moduleReference);
    if (!binding) {
      throw new Error(`Missing route import for ${moduleReference}`);
    }
    if (binding.kind === "namespace") {
      throw new Error(
        `Unsupported route import binding for ${moduleReference}; namespace imports cannot be mounted`,
      );
    }
    const nestedPath = argumentsList.length === 2 ? parseLiteralPath(argumentsList[0]) : "";
    if (nestedPath === undefined) {
      throw new Error(`Unsupported route mount path for ${moduleReference}`);
    }
    mounts.push({
      moduleName: binding.moduleName,
      mount: normalizePath(`${mount}/${nestedPath}`),
    });
  }

  return mounts;
}

function deriveMountGraph({ rootSource, rootMount, readModuleSource }) {
  const graph = [];
  const visitedMounts = new Set();

  function visit(moduleName, mount) {
    const visitKey = `${moduleName}@${mount}`;
    if (visitedMounts.has(visitKey)) return;
    visitedMounts.add(visitKey);

    const source = readModuleSource(moduleName);
    graph.push({ moduleName, mount, source });
    for (const nestedMount of parseRouteMounts(source, mount)) {
      visit(nestedMount.moduleName, nestedMount.mount);
    }
    for (const reExportedModule of parseReExportedModules(source)) {
      visit(reExportedModule, mount);
    }
  }

  for (const mount of parseRouteMounts(rootSource, rootMount)) {
    visit(mount.moduleName, mount.mount);
  }

  return graph;
}

module.exports = { deriveMountGraph, parseRouteMounts };
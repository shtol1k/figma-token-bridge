/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 380, height: 220 });

interface FolderByFile {
  [fileKey: string]: string;
}

interface CollectionSummary {
  id: string;
  name: string;
  modes: { modeId: string; name: string }[];
}

interface AliasInfo {
  targetVariableId: string;
  targetVariableName: string;
  targetVariableSetId: string;
  targetVariableSetName: string;
}

const STORAGE_KEY = "folderByFile";

function currentFileKey(): string {
  // figma.fileKey is null for a file that hasn't been saved to Figma yet.
  return figma.fileKey ?? "unsaved";
}

async function getFolderMap(): Promise<FolderByFile> {
  const stored = await figma.clientStorage.getAsync(STORAGE_KEY);
  return (stored as FolderByFile | undefined) ?? {};
}

async function getFolder(): Promise<string | null> {
  const map = await getFolderMap();
  return map[currentFileKey()] ?? null;
}

async function setFolder(folderPath: string): Promise<void> {
  const map = await getFolderMap();
  map[currentFileKey()] = folderPath;
  await figma.clientStorage.setAsync(STORAGE_KEY, map);
}

async function sendCollections(): Promise<void> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const folder = await getFolder();
  const summaries: CollectionSummary[] = collections.map((c) => ({
    id: c.id,
    name: c.name,
    modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
  }));
  figma.ui.postMessage({ type: "collections", collections: summaries, folder });
}

function isAlias(value: VariableValue): value is VariableAlias {
  return typeof value === "object" && value !== null && (value as VariableAlias).type === "VARIABLE_ALIAS";
}

function toHex2(n: number): string {
  const clamped = Math.max(0, Math.min(1, n));
  return Math.round(clamped * 255).toString(16).padStart(2, "0").toUpperCase();
}

function formatValue(
  resolvedType: VariableResolvedDataType,
  value: VariableValue,
): { type: string; value: unknown } {
  if (resolvedType === "COLOR") {
    const c = value as RGBA;
    return {
      type: "color",
      value: {
        colorSpace: "srgb",
        components: [c.r, c.g, c.b],
        alpha: c.a,
        hex: `#${toHex2(c.r)}${toHex2(c.g)}${toHex2(c.b)}`,
      },
    };
  }
  if (resolvedType === "FLOAT") {
    return { type: "number", value: value as number };
  }
  if (resolvedType === "STRING") {
    return { type: "string", value: value as string };
  }
  return { type: "boolean", value: value as boolean };
}

/**
 * Recursively resolves a variable's value for a given mode, following
 * VARIABLE_ALIAS chains to a concrete value. Records only the immediate
 * (first-hop) alias target in `alias`, matching the shape already present
 * in docs/tokens/theme/*.tokens.json — deeper chains still resolve `value`
 * correctly, they just aren't listed hop-by-hop.
 */
async function resolveVariableValue(
  variable: Variable,
  modeId: string,
): Promise<{ value: VariableValue; alias: AliasInfo | null }> {
  const raw = variable.valuesByMode[modeId];

  if (!isAlias(raw)) {
    return { value: raw, alias: null };
  }

  const target = await figma.variables.getVariableByIdAsync(raw.id);
  if (!target) {
    // Stale alias (target deleted) — surface the raw pointer rather than crash.
    return { value: raw, alias: null };
  }

  const targetCollection = await figma.variables.getVariableCollectionByIdAsync(
    target.variableCollectionId,
  );
  const targetModeId = target.valuesByMode[modeId] !== undefined
    ? modeId
    : Object.keys(target.valuesByMode)[0];

  const resolved = await resolveVariableValue(target, targetModeId);

  return {
    value: resolved.value,
    alias: {
      targetVariableId: target.id,
      targetVariableName: target.name,
      targetVariableSetId: target.variableCollectionId,
      targetVariableSetName: targetCollection ? targetCollection.name : "",
    },
  };
}

function setPath(root: Record<string, unknown>, segments: string[], leaf: unknown): void {
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (typeof node[key] !== "object" || node[key] === null) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = leaf;
}

async function serializeCollectionMode(
  collection: VariableCollection,
  modeId: string,
): Promise<Record<string, unknown>> {
  const allVars = await figma.variables.getLocalVariablesAsync();
  const vars = allVars.filter((v) => v.variableCollectionId === collection.id);
  const root: Record<string, unknown> = {};

  for (const v of vars) {
    const { value, alias } = await resolveVariableValue(v, modeId);
    const { type, value: formattedValue } = formatValue(v.resolvedType, value);

    const extensions: Record<string, unknown> = {
      "com.figma.variableId": v.id,
      "com.figma.scopes": v.scopes,
    };
    if (v.codeSyntax && Object.keys(v.codeSyntax).length > 0) {
      extensions["com.figma.codeSyntax"] = { ...v.codeSyntax };
    }
    if (alias) {
      extensions["com.figma.aliasData"] = alias;
    }

    const leaf: Record<string, unknown> = { $type: type, $value: formattedValue };
    if (v.description) {
      leaf.$description = v.description;
    }
    leaf.$extensions = extensions;

    setPath(root, v.name.split("/"), leaf);
  }

  return root;
}

interface ImportSummary {
  createdNames: Set<string>;
  deletedNames: Set<string>;
  updatedNames: Set<string>;
  removedNames: Set<string>;
  nameChanges: number;
  valueChanges: number;
  scopeChanges: number;
  descriptionChanges: number;
  codeSyntaxChanges: number;
  notes: string[];
}

function valuesEqual(a: VariableValue, b: VariableValue): boolean {
  const aliasA = isAlias(a);
  const aliasB = isAlias(b);
  if (aliasA || aliasB) {
    return aliasA && aliasB && a.id === b.id;
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ca = a as RGBA;
    const cb = b as RGBA;
    return (
      Math.abs(ca.r - cb.r) < 1e-6 &&
      Math.abs(ca.g - cb.g) < 1e-6 &&
      Math.abs(ca.b - cb.b) < 1e-6 &&
      Math.abs(ca.a - cb.a) < 1e-6
    );
  }
  return a === b;
}

function typeToResolvedType(dtcgType: string): VariableResolvedDataType {
  if (dtcgType === "color") return "COLOR";
  if (dtcgType === "number") return "FLOAT";
  if (dtcgType === "boolean") return "BOOLEAN";
  return "STRING";
}

function toFigmaValue(dtcgType: string, dtcgValue: any): VariableValue {
  if (dtcgType === "color") {
    return {
      r: dtcgValue.components[0],
      g: dtcgValue.components[1],
      b: dtcgValue.components[2],
      a: dtcgValue.alpha,
    } as RGBA;
  }
  return dtcgValue as VariableValue;
}

function flattenTokens(
  obj: Record<string, any>,
  prefix: string[] = [],
): { path: string[]; node: any }[] {
  const out: { path: string[]; node: any }[] = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === "object" && "$value" in val) {
      out.push({ path: [...prefix, key], node: val });
    } else if (val && typeof val === "object") {
      out.push(...flattenTokens(val, [...prefix, key]));
    }
  }
  return out;
}

/**
 * Variables that exist in this Figma collection but aren't referenced by
 * name in any of the files being imported for it — candidates for removal
 * if the caller opts into delete-sync. Computed from file content alone,
 * so it's safe to call both before (for the confirmation dialog) and
 * after (to actually remove) the main import pass.
 */
async function computeMissingVariables(
  collection: VariableCollection,
  files: { filename: string; content: Record<string, any> }[],
): Promise<Variable[]> {
  const allLocalVars = await figma.variables.getLocalVariablesAsync();
  const collectionVars = allLocalVars.filter((v) => v.variableCollectionId === collection.id);
  const importedNames = new Set<string>();
  for (const file of files) {
    for (const { path } of flattenTokens(file.content)) {
      importedNames.add(path.join("/"));
    }
  }
  return collectionVars.filter((v) => !importedNames.has(v.name));
}

/**
 * Match key: com.figma.variableId first (survives rename/move — the whole
 * point of carrying it), falling back to name matching only when the ID is
 * missing (brand-new, code-authored token) or stale (target deleted in
 * Figma since the last export).
 *
 * IMPORTANT: `getVariableByIdAsync` has been observed to still resolve a
 * variable ID for a short window after the variable was deleted in the
 * Figma UI (a tombstoned record no longer visible or enumerable, but still
 * directly fetchable by ID) — it does not reliably return `null` the way
 * its documentation implies. `getLocalVariablesAsync()` is the source that
 * correctly excludes deleted variables, so every ID lookup here is
 * cross-checked against that enumerable list before being trusted. Relying
 * on `getVariableByIdAsync` alone silently no-ops `setValueForMode` on a
 * tombstoned object — no error, no visible effect in Figma, and the token
 * gets counted as "updated" instead of "created".
 */
async function importFile(
  collection: VariableCollection,
  modeId: string,
  content: Record<string, any>,
  summary: ImportSummary,
): Promise<void> {
  const tokens = flattenTokens(content);
  const allLocalVars = await figma.variables.getLocalVariablesAsync();
  const liveIds = new Set(allLocalVars.map((v) => v.id));
  const collectionVars = allLocalVars.filter((v) => v.variableCollectionId === collection.id);

  function findByName(name: string): Variable | null {
    return collectionVars.find((v) => v.name === name) ?? null;
  }
  function findAnyByName(name: string): Variable | null {
    return allLocalVars.find((v) => v.name === name) ?? null;
  }

  for (const { path: tokenPath, node } of tokens) {
    const name = tokenPath.join("/");
    const extensions = node.$extensions ?? {};
    const variableId: string | undefined = extensions["com.figma.variableId"];

    let variable: Variable | null = null;

    if (variableId && liveIds.has(variableId)) {
      variable = await figma.variables.getVariableByIdAsync(variableId);
    }

    if (!variable) {
      if (variableId) {
        summary.deletedNames.add(name);
      }
      const byName = findByName(name);
      if (byName) {
        variable = byName;
        if (variableId) {
          summary.notes.push(
            `"${name}": stale/removed ID ${variableId} — matched an existing variable by name instead (${byName.id}).`,
          );
        }
      }
    }

    let isNew = false;
    let tokenChanged = false;
    if (!variable) {
      isNew = true;
      variable = figma.variables.createVariable(name, collection, typeToResolvedType(node.$type));
      collectionVars.push(variable);
      allLocalVars.push(variable);
      liveIds.add(variable.id);
      summary.createdNames.add(name);
    } else if (variable.name !== name) {
      variable.name = name;
      summary.nameChanges++;
      tokenChanged = true;
    }

    const aliasData = extensions["com.figma.aliasData"];
    let desiredValue: VariableValue | null = null;
    if (aliasData) {
      let target =
        aliasData.targetVariableId && liveIds.has(aliasData.targetVariableId)
          ? await figma.variables.getVariableByIdAsync(aliasData.targetVariableId)
          : null;
      if (!target && aliasData.targetVariableName) {
        target = findAnyByName(aliasData.targetVariableName);
      }
      if (target) {
        desiredValue = { type: "VARIABLE_ALIAS", id: target.id };
      } else {
        summary.notes.push(
          `Alias target not found for "${name}" (wanted "${aliasData.targetVariableName}") — value left unset.`,
        );
      }
    } else {
      desiredValue = toFigmaValue(node.$type, node.$value);
    }
    if (desiredValue !== null) {
      const currentValue = variable.valuesByMode[modeId];
      const unchanged = !isNew && currentValue !== undefined && valuesEqual(currentValue, desiredValue);
      if (!unchanged) {
        variable.setValueForMode(modeId, desiredValue);
        if (!isNew) {
          summary.valueChanges++;
          tokenChanged = true;
        }
      }
    }

    const desiredDescription = node.$description ?? "";
    if (variable.description !== desiredDescription) {
      variable.description = desiredDescription;
      if (!isNew) {
        summary.descriptionChanges++;
        tokenChanged = true;
      }
    }

    const scopes = extensions["com.figma.scopes"];
    if (Array.isArray(scopes)) {
      const current = variable.scopes;
      const scopesChanged =
        current.length !== scopes.length || scopes.some((s: string, i: number) => current[i] !== s);
      if (scopesChanged) {
        variable.scopes = scopes as VariableScope[];
        if (!isNew) {
          summary.scopeChanges++;
          tokenChanged = true;
        }
      }
    }

    const codeSyntax = extensions["com.figma.codeSyntax"];
    if (codeSyntax) {
      let codeSyntaxTokenChanged = false;
      for (const platform of Object.keys(codeSyntax) as CodeSyntaxPlatform[]) {
        if (variable.codeSyntax[platform] !== codeSyntax[platform]) {
          variable.setVariableCodeSyntax(platform, codeSyntax[platform]);
          codeSyntaxTokenChanged = true;
        }
      }
      if (codeSyntaxTokenChanged && !isNew) {
        summary.codeSyntaxChanges++;
        tokenChanged = true;
      }
    }

    if (!isNew && tokenChanged) {
      summary.updatedNames.add(name);
    }
  }
}

figma.ui.onmessage = async (msg: any) => {
  if (msg.type === "get-collections") {
    await sendCollections();
    return;
  }

  if (msg.type === "resize-ui") {
    figma.ui.resize(msg.width, msg.height);
    return;
  }

  if (msg.type === "save-folder") {
    await setFolder(msg.folderPath);
    await sendCollections();
    return;
  }

  if (msg.type === "export") {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const targets =
      msg.collectionId === "ALL" ? collections : collections.filter((c) => c.id === msg.collectionId);
    if (targets.length === 0) return;

    const files: { relativePath: string; content: unknown }[] = [];
    for (const target of targets) {
      for (const mode of target.modes) {
        const tree = await serializeCollectionMode(target, mode.modeId);
        files.push({
          relativePath: `${target.name.toLowerCase()}/${mode.name.toLowerCase()}.tokens.json`,
          content: tree,
        });
      }
    }

    figma.ui.postMessage({ type: "do-export", dir: msg.dir, files });
    return;
  }

  if (msg.type === "check-import") {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const groups = msg.groups as {
      collectionId: string;
      files: { filename: string; content: Record<string, any> }[];
    }[];

    const missing: string[] = [];
    for (const group of groups) {
      const target = collections.find((c) => c.id === group.collectionId);
      if (!target) continue;
      const missingVars = await computeMissingVariables(target, group.files);
      for (const v of missingVars) missing.push(v.name);
    }

    figma.ui.postMessage({ type: "import-check-result", missing });
    return;
  }

  if (msg.type === "import") {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const summary: ImportSummary = {
      createdNames: new Set(),
      deletedNames: new Set(),
      updatedNames: new Set(),
      removedNames: new Set(),
      nameChanges: 0,
      valueChanges: 0,
      scopeChanges: 0,
      descriptionChanges: 0,
      codeSyntaxChanges: 0,
      notes: [],
    };

    const groups = msg.groups as {
      collectionId: string;
      files: { filename: string; content: Record<string, any> }[];
    }[];

    for (const group of groups) {
      const target = collections.find((c) => c.id === group.collectionId);
      if (!target) continue;

      if (msg.deleteMissing) {
        const missingVars = await computeMissingVariables(target, group.files);
        for (const v of missingVars) {
          summary.removedNames.add(v.name);
          v.remove();
        }
      }

      for (const file of group.files) {
        const modeName = file.filename.replace(/\.tokens\.json$/, "");
        const mode = target.modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase());
        if (!mode) {
          summary.notes.push(`No mode matching file "${file.filename}" in "${target.name}" — skipped.`);
          continue;
        }
        await importFile(target, mode.modeId, file.content, summary);
      }
    }

    figma.ui.postMessage({
      type: "import-result",
      summary: {
        created: Array.from(summary.createdNames),
        deleted: Array.from(summary.deletedNames),
        removed: Array.from(summary.removedNames),
        updated: Array.from(summary.updatedNames),
        nameChanges: summary.nameChanges,
        valueChanges: summary.valueChanges,
        scopeChanges: summary.scopeChanges,
        descriptionChanges: summary.descriptionChanges,
        codeSyntaxChanges: summary.codeSyntaxChanges,
        notes: summary.notes,
      },
    });
  }
};

void sendCollections();

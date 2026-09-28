/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 380, height: 260 });

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

/**
 * A COLOR variable value that carries a separate opacity, with at least one
 * of the two being an alias — Figma's "alias + opacity". Not in
 * @figma/plugin-typings (1.134), so it's typed here. Figma's own validator
 * accepts exactly two forms (a literal color with a literal opacity is just
 * RGBA):
 *
 * - `color` aliases a color variable; `opacity` is a literal or an alias;
 * - `color` is a literal (a hex picked in the UI); `opacity` is an alias.
 *
 * `opacity` is on Figma's 0–100 scale (48 means 48%); an opacity alias points
 * at a FLOAT variable. Observed resolution (via `resolveForConsumer`): when
 * the color is opaque, the resolved alpha is `opacity / 100`; when the color
 * is itself translucent, the opacity is ignored and the color's alpha wins.
 */
type ColorWithOpacity =
  | { color: VariableAlias; opacity: number | VariableAlias }
  | { color: RGB | RGBA; opacity: VariableAlias };

/** What `variable.valuesByMode[modeId]` can actually hold at runtime. */
type RawVariableValue = VariableValue | ColorWithOpacity;

// The bundled typings only accept VariableValue; the API itself accepts the
// color+opacity shapes too (verified with setValueForMode on a live file).
interface Variable {
  setValueForMode(modeId: string, newValue: ColorWithOpacity): void;
}

/**
 * `com.figma.aliasWithOpacity` — see README "Alias + opacity". `color` is
 * either a reference (the four `target*` fields) or, for a literal color,
 * `{ value: <DTCG color> }`.
 */
interface AliasWithOpacityInfo {
  color: (AliasInfo & { stale?: true }) | { value: unknown };
  opacity: { value: number } & Partial<AliasInfo> & { stale?: true };
}

/** Per-export context: which variable IDs are really alive, plus user-facing notes. */
interface ExportContext {
  liveIds: Set<string>;
  notes: string[];
}

async function newExportContext(): Promise<ExportContext> {
  const all = await figma.variables.getLocalVariablesAsync();
  return { liveIds: new Set(all.map((v) => v.id)), notes: [] };
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

function isAlias(value: unknown): value is VariableAlias {
  return typeof value === "object" && value !== null && (value as VariableAlias).type === "VARIABLE_ALIAS";
}

function isColorLiteral(value: unknown): value is RGB | RGBA {
  return typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value;
}

function isColorWithOpacity(value: unknown): value is ColorWithOpacity {
  if (typeof value !== "object" || value === null || !("color" in value) || !("opacity" in value)) return false;
  const v = value as ColorWithOpacity;
  if (isAlias(v.color)) return typeof v.opacity === "number" || isAlias(v.opacity);
  return isColorLiteral(v.color) && isAlias(v.opacity);
}

function rawValue(variable: Variable, modeId: string): RawVariableValue | undefined {
  return variable.valuesByMode[modeId] as RawVariableValue | undefined;
}

function setRawValueForMode(variable: Variable, modeId: string, value: RawVariableValue): void {
  if (isColorWithOpacity(value)) {
    variable.setValueForMode(modeId, value);
  } else {
    variable.setValueForMode(modeId, value);
  }
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
 * `getVariableByIdAsync` can still return a deleted variable (a tombstone —
 * see importFile). A target is only trusted as live if it's in the local
 * enumeration or comes from a library (`remote`). A tombstone is still
 * returned so callers can use its last-known name/value, flagged `stale`.
 */
async function lookupVariable(
  id: string,
  ctx: ExportContext,
): Promise<{ variable: Variable | null; stale: boolean }> {
  const variable = await figma.variables.getVariableByIdAsync(id);
  const live = variable !== null && (variable.remote || ctx.liveIds.has(variable.id));
  return { variable, stale: !live };
}

async function aliasInfo(target: Variable): Promise<AliasInfo> {
  const targetCollection = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId);
  return {
    targetVariableId: target.id,
    targetVariableName: target.name,
    targetVariableSetId: target.variableCollectionId,
    targetVariableSetName: targetCollection ? targetCollection.name : "",
  };
}

/** A target in another collection may not have `modeId`; fall back to its first mode. */
function modeFor(variable: Variable, modeId: string): string {
  return variable.valuesByMode[modeId] !== undefined ? modeId : Object.keys(variable.valuesByMode)[0];
}

/** Figma's observed rule — see ColorWithOpacity. */
function applyAliasOpacity(color: RGB | RGBA, opacity: number): RGBA {
  const targetAlpha = "a" in color ? color.a : 1;
  return { r: color.r, g: color.g, b: color.b, a: targetAlpha < 1 ? targetAlpha : opacity / 100 };
}

/**
 * Follows plain-alias and alias+opacity chains to a concrete value, so a
 * plain alias pointing at an alias+opacity variable still flattens
 * correctly. Tombstoned targets resolve to their last-known value (Figma
 * keeps rendering it); the caller is responsible for flagging staleness.
 * Returns null when nothing concrete can be reached (target gone entirely,
 * a cycle, or a type mismatch) — never a half-built value.
 */
async function resolveConcrete(
  variable: Variable,
  modeId: string,
  seen: Set<string> = new Set(),
): Promise<VariableValue | null> {
  if (seen.has(variable.id)) return null;
  const chain = new Set(seen).add(variable.id);
  const raw = rawValue(variable, modeId);
  if (raw === undefined) return null;

  if (isColorWithOpacity(raw)) {
    const color = isAlias(raw.color) ? await resolveAliasTarget(raw.color, modeId, chain) : raw.color;
    if (!isColorLiteral(color)) return null;
    const opacity = typeof raw.opacity === "number" ? raw.opacity : await resolveAliasTarget(raw.opacity, modeId, chain);
    if (typeof opacity !== "number") return null;
    return applyAliasOpacity(color, opacity);
  }
  if (isAlias(raw)) {
    return resolveAliasTarget(raw, modeId, chain);
  }
  return raw;
}

async function resolveAliasTarget(
  alias: VariableAlias,
  modeId: string,
  seen: Set<string>,
): Promise<VariableValue | null> {
  const target = await figma.variables.getVariableByIdAsync(alias.id);
  if (!target) return null;
  return resolveConcrete(target, modeFor(target, modeId), seen);
}

/**
 * The `$value` plus the reference-describing `$extensions` for one variable
 * in one mode. Plain values and live plain aliases produce exactly the
 * pre-existing shape (`com.figma.aliasData` = first hop, `$value` = fully
 * resolved). Returns null if no concrete value exists at all; the caller
 * omits the token and says so.
 */
async function serializeVariableValue(
  v: Variable,
  modeId: string,
  ctx: ExportContext,
): Promise<{ type: string; value: unknown; extensions: Record<string, unknown> } | null> {
  const raw = rawValue(v, modeId);
  const resolved = await resolveConcrete(v, modeId);
  if (raw === undefined || resolved === null) return null;

  const extensions: Record<string, unknown> = {};

  if (isColorWithOpacity(raw)) {
    // resolveConcrete succeeded, so every alias target exists (possibly as a tombstone).
    let colorStale = false;
    let colorValue: RGB | RGBA = raw.color as RGB | RGBA;
    const info: AliasWithOpacityInfo = { color: { value: null }, opacity: { value: 0 } };
    if (isAlias(raw.color)) {
      const color = await lookupVariable(raw.color.id, ctx);
      colorStale = color.stale;
      colorValue = (await resolveConcrete(color.variable!, modeFor(color.variable!, modeId))) as RGB | RGBA;
      info.color = { ...(await aliasInfo(color.variable!)), ...(colorStale ? { stale: true as const } : {}) };
    } else {
      info.color = { value: formatValue("COLOR", { a: 1, ...raw.color }).value };
    }

    if (typeof raw.opacity === "number") {
      info.opacity = { value: raw.opacity };
    } else {
      const op = await lookupVariable(raw.opacity.id, ctx);
      const opValue = await resolveConcrete(op.variable!, modeFor(op.variable!, modeId));
      info.opacity = { value: opValue as number, ...(await aliasInfo(op.variable!)) };
      if (op.stale) info.opacity.stale = true;
    }
    extensions["com.figma.aliasWithOpacity"] = info;

    if ("a" in colorValue && colorValue.a < 1) {
      ctx.notes.push(
        `"${v.name}": color is translucent — Figma ignores the opacity (${info.opacity.value}) in that case; exported alpha is the color's.`,
      );
    }
    if (colorStale || info.opacity.stale) {
      ctx.notes.push(`"${v.name}": alias + opacity points at a deleted variable — exported its last-known value, flagged stale.`);
    }
  } else if (isAlias(raw)) {
    const target = await lookupVariable(raw.id, ctx);
    if (target.stale) {
      extensions["com.figma.staleAlias"] = {
        targetVariableId: raw.id,
        ...(target.variable ? { targetVariableName: target.variable.name } : {}),
      };
      ctx.notes.push(`"${v.name}": alias target was deleted — exported its last-known value, flagged stale.`);
    } else {
      extensions["com.figma.aliasData"] = await aliasInfo(target.variable!);
    }
  }

  const { type, value } = formatValue(v.resolvedType, resolved);
  return { type, value, extensions };
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
  ctx: ExportContext,
): Promise<Record<string, unknown>> {
  const allVars = await figma.variables.getLocalVariablesAsync();
  const vars = allVars.filter((v) => v.variableCollectionId === collection.id);
  const root: Record<string, unknown> = {};

  for (const v of vars) {
    const serialized = await serializeVariableValue(v, modeId, ctx);
    if (!serialized) {
      ctx.notes.push(
        `"${v.name}": no resolvable value in this mode (alias target gone) — left out of the file. Cancel the delete prompt on the next Import.`,
      );
      continue;
    }

    const extensions: Record<string, unknown> = {
      "com.figma.variableId": v.id,
      "com.figma.scopes": v.scopes,
    };
    if (v.codeSyntax && Object.keys(v.codeSyntax).length > 0) {
      extensions["com.figma.codeSyntax"] = { ...v.codeSyntax };
    }
    Object.assign(extensions, serialized.extensions);

    const leaf: Record<string, unknown> = { $type: serialized.type, $value: serialized.value };
    if (v.description) {
      leaf.$description = v.description;
    }
    leaf.$extensions = extensions;

    setPath(root, v.name.split("/"), leaf);
  }

  return root;
}

/**
 * Paths of every non-finite number (and any "NaN" string, e.g. a hex built
 * from one) in an export tree. Export refuses to write a file with any —
 * JSON.stringify would silently turn NaN into null.
 */
function findNonFinite(node: unknown, path: string, out: string[]): string[] {
  if (typeof node === "number") {
    if (!Number.isFinite(node)) out.push(path);
  } else if (typeof node === "string") {
    if (/^#/.test(node) && /nan/i.test(node)) out.push(path);
  } else if (Array.isArray(node)) {
    node.forEach((child, i) => findNonFinite(child, `${path}[${i}]`, out));
  } else if (typeof node === "object" && node !== null) {
    for (const key of Object.keys(node)) {
      findNonFinite((node as Record<string, unknown>)[key], path ? `${path}/${key}` : key, out);
    }
  }
  return out;
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

function valuesEqual(a: RawVariableValue, b: RawVariableValue): boolean {
  const withOpacityA = isColorWithOpacity(a);
  const withOpacityB = isColorWithOpacity(b);
  if (withOpacityA || withOpacityB) {
    if (!withOpacityA || !withOpacityB) return false;
    const oa = a.opacity;
    const ob = b.opacity;
    const opacityEqual =
      typeof oa === "number" && typeof ob === "number"
        ? Math.abs(oa - ob) < 1e-4
        : isAlias(oa) && isAlias(ob) && oa.id === ob.id;
    const ca = a.color;
    const cb = b.color;
    const colorEqual = isAlias(ca) || isAlias(cb) ? valuesEqual(ca, cb) : valuesEqual({ a: 1, ...ca }, { a: 1, ...cb });
    return colorEqual && opacityEqual;
  }
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

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Returns null for anything that isn't a well-formed value of `dtcgType` — never a partial one. */
function toFigmaValue(dtcgType: string, dtcgValue: any): VariableValue | null {
  if (dtcgType === "color") {
    const c = dtcgValue?.components;
    const alpha = dtcgValue?.alpha ?? 1;
    if (!Array.isArray(c) || c.length !== 3 || !c.every(isFiniteNumber) || !isFiniteNumber(alpha)) {
      return null;
    }
    return { r: c[0], g: c[1], b: c[2], a: alpha };
  }
  if (dtcgType === "number") return isFiniteNumber(dtcgValue) ? dtcgValue : null;
  if (dtcgType === "boolean") return typeof dtcgValue === "boolean" ? dtcgValue : null;
  return typeof dtcgValue === "string" ? dtcgValue : null;
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
  const collections = await figma.variables.getLocalVariableCollectionsAsync();

  function findByName(name: string): Variable | null {
    return collectionVars.find((v) => v.name === name) ?? null;
  }
  function findAnyByName(name: string): Variable | null {
    return allLocalVars.find((v) => v.name === name) ?? null;
  }

  async function findLiveTarget(ref: any, resolvedType: VariableResolvedDataType): Promise<Variable | null> {
    let target: Variable | null = null;
    if (ref.targetVariableId && liveIds.has(ref.targetVariableId)) {
      target = await figma.variables.getVariableByIdAsync(ref.targetVariableId);
    }
    if (!target && ref.targetVariableName) {
      // Names repeat across collections ("8" in opacity vs spacing), so prefer the recorded one.
      const set = collections.find((c) => c.name === ref.targetVariableSetName);
      target =
        allLocalVars.find((v) => v.name === ref.targetVariableName && (!set || v.variableCollectionId === set.id)) ??
        null;
    }
    return target && target.resolvedType === resolvedType ? target : null;
  }

  /** The value to write for one token, or null (with a note naming the token) to leave it alone. */
  async function desiredValueFor(name: string, node: any, extensions: any): Promise<RawVariableValue | null> {
    const staleAlias = extensions["com.figma.staleAlias"];
    if (staleAlias) {
      summary.notes.push(
        `"${name}": skipped — exported as a stale alias (target ${staleAlias.targetVariableName ?? staleAlias.targetVariableId} was deleted); Figma left as is.`,
      );
      return null;
    }

    const withOpacity = extensions["com.figma.aliasWithOpacity"];
    if (withOpacity) {
      const ref = withOpacity.color ?? {};
      const op = withOpacity.opacity ?? {};
      if (ref.stale || op.stale) {
        summary.notes.push(`"${name}": skipped — alias + opacity was exported with a deleted target; Figma left as is.`);
        return null;
      }
      let color: VariableAlias | RGBA;
      if (ref.targetVariableId || ref.targetVariableName) {
        const colorTarget = await findLiveTarget(ref, "COLOR");
        if (!colorTarget) {
          summary.notes.push(`"${name}": skipped — alias + opacity color target "${ref.targetVariableName}" not found.`);
          return null;
        }
        color = { type: "VARIABLE_ALIAS", id: colorTarget.id };
      } else {
        const literal = toFigmaValue("color", ref.value);
        if (literal === null) {
          summary.notes.push(`"${name}": skipped — alias + opacity has malformed color ${JSON.stringify(ref.value)}.`);
          return null;
        }
        color = literal as RGBA;
      }
      let opacity: number | VariableAlias;
      if (op.targetVariableId || op.targetVariableName) {
        const opacityTarget = await findLiveTarget(op, "FLOAT");
        if (!opacityTarget) {
          summary.notes.push(`"${name}": skipped — alias + opacity number target "${op.targetVariableName}" not found.`);
          return null;
        }
        opacity = { type: "VARIABLE_ALIAS", id: opacityTarget.id };
      } else if (isFiniteNumber(op.value) && op.value >= 0 && op.value <= 100) {
        opacity = op.value;
      } else {
        summary.notes.push(`"${name}": skipped — alias + opacity has invalid opacity ${JSON.stringify(op.value)} (want 0–100).`);
        return null;
      }
      if (isAlias(color)) return { color, opacity };
      if (isAlias(opacity)) return { color, opacity };
      // Figma rejects a literal color with a literal opacity (that's just RGBA).
      summary.notes.push(`"${name}": skipped — alias + opacity with neither color nor opacity aliased isn't a shape Figma accepts.`);
      return null;
    }

    const aliasData = extensions["com.figma.aliasData"];
    if (aliasData) {
      let target =
        aliasData.targetVariableId && liveIds.has(aliasData.targetVariableId)
          ? await figma.variables.getVariableByIdAsync(aliasData.targetVariableId)
          : null;
      if (!target && aliasData.targetVariableName) {
        target = findAnyByName(aliasData.targetVariableName);
      }
      if (target) {
        return { type: "VARIABLE_ALIAS", id: target.id };
      }
      summary.notes.push(
        `Alias target not found for "${name}" (wanted "${aliasData.targetVariableName}") — value left unset.`,
      );
      return null;
    }

    const value = toFigmaValue(node.$type, node.$value);
    if (value === null) {
      summary.notes.push(`"${name}": skipped — malformed ${node.$type} value ${JSON.stringify(node.$value)}.`);
    }
    return value;
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

    // Decided before creating anything: a token whose value can't be
    // written faithfully is skipped (with a note naming it), never created
    // empty or written half-resolved.
    const desiredValue = await desiredValueFor(name, node, extensions);
    if (desiredValue === null && !variable) {
      summary.notes.push(`"${name}": not created — no value could be written (see above).`);
      continue;
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

    if (desiredValue !== null) {
      const currentValue = rawValue(variable, modeId);
      const unchanged = !isNew && currentValue !== undefined && valuesEqual(currentValue, desiredValue);
      if (!unchanged) {
        setRawValueForMode(variable, modeId, desiredValue);
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

type StyleKind = "PAINT" | "TEXT" | "EFFECT" | "GRID";

async function getLocalStyles(kind: StyleKind): Promise<BaseStyle[]> {
  if (kind === "PAINT") return figma.getLocalPaintStylesAsync();
  if (kind === "TEXT") return figma.getLocalTextStylesAsync();
  if (kind === "EFFECT") return figma.getLocalEffectStylesAsync();
  return figma.getLocalGridStylesAsync();
}

function createStyleOfKind(kind: StyleKind): BaseStyle {
  if (kind === "PAINT") return figma.createPaintStyle();
  if (kind === "TEXT") return figma.createTextStyle();
  if (kind === "EFFECT") return figma.createEffectStyle();
  return figma.createGridStyle();
}

/**
 * Paint/Effect/Grid styles can each hold an *array* of layers (multiple
 * paints, multiple shadows/blurs, multiple grids) — richer than a single
 * value, and not something the W3C color/shadow composite types cover
 * cleanly. Represented as a Figma-specific `$type` with the raw array as
 * `$value` (deep-cloned to strip Figma's read-only wrapper objects down
 * to plain JSON) rather than force-fitting into a spec type that would
 * lose data. Text styles are close enough to the spec's `typography`
 * composite to use it directly, with the properties DTCG doesn't have a
 * slot for (paragraph spacing, text case, etc.) carried in `$extensions`.
 */
function serializeStyleValue(kind: StyleKind, style: BaseStyle): { type: string; value: unknown; extras?: unknown } {
  if (kind === "PAINT") {
    return { type: "figmaPaint", value: JSON.parse(JSON.stringify((style as PaintStyle).paints)) };
  }
  if (kind === "EFFECT") {
    return { type: "figmaEffect", value: JSON.parse(JSON.stringify((style as EffectStyle).effects)) };
  }
  if (kind === "GRID") {
    return { type: "figmaGrid", value: JSON.parse(JSON.stringify((style as GridStyle).layoutGrids)) };
  }
  const t = style as TextStyle;
  return {
    type: "typography",
    value: {
      fontFamily: t.fontName.family,
      fontWeight: t.fontName.style,
      fontSize: t.fontSize,
      letterSpacing: JSON.parse(JSON.stringify(t.letterSpacing)),
      lineHeight: JSON.parse(JSON.stringify(t.lineHeight)),
    },
    extras: {
      paragraphIndent: t.paragraphIndent,
      paragraphSpacing: t.paragraphSpacing,
      listSpacing: t.listSpacing,
      textCase: t.textCase,
      textDecoration: t.textDecoration,
      leadingTrim: t.leadingTrim,
      hangingPunctuation: t.hangingPunctuation,
      hangingList: t.hangingList,
    },
  };
}

/** The part of a Paint / Effect / LayoutGrid that can carry variable bindings. */
interface BindableLayer {
  readonly boundVariables?: { readonly [field: string]: VariableAlias | undefined };
  readonly gradientStops?: ReadonlyArray<{ readonly boundVariables?: { readonly color?: VariableAlias } }>;
}

/** One entry of `com.figma.boundVariables` — see README "Styles bound to variables". */
interface StyleBinding {
  layer: number;
  field: string;
  variableId: string;
  variableName: string;
  variableSetId: string;
  variableSetName: string;
  stale?: true;
  valuesByMode: { [modeName: string]: unknown };
}

function styleLayers(kind: StyleKind, style: BaseStyle): ReadonlyArray<object> {
  if (kind === "PAINT") return (style as PaintStyle).paints;
  if (kind === "EFFECT") return (style as EffectStyle).effects;
  if (kind === "GRID") return (style as GridStyle).layoutGrids;
  return [];
}

/** Every `{layer, field, alias}` binding on a list of style layers, gradient stops included. */
function layerBindings(layers: ReadonlyArray<object>): { layer: number; field: string; alias: VariableAlias }[] {
  const out: { layer: number; field: string; alias: VariableAlias }[] = [];
  layers.forEach((l, i) => {
    const layer = l as BindableLayer;
    for (const field of Object.keys(layer.boundVariables ?? {})) {
      const alias = layer.boundVariables![field];
      if (isAlias(alias)) out.push({ layer: i, field, alias });
    }
    (layer.gradientStops ?? []).forEach((stop, j) => {
      const alias = stop.boundVariables?.color;
      if (isAlias(alias)) out.push({ layer: i, field: `gradientStops.${j}.color`, alias });
    });
  });
  return out;
}

/**
 * A style has no modes, but the variables bound to its layers do — so for
 * each binding, record the variable's name and its resolved value in every
 * mode of the variable's own collection. The raw `$value` array only holds
 * Figma's snapshot of the default mode.
 */
async function serializeStyleBindings(
  styleName: string,
  layers: ReadonlyArray<object>,
  ctx: ExportContext,
): Promise<StyleBinding[]> {
  const out: StyleBinding[] = [];
  for (const { layer, field, alias } of layerBindings(layers)) {
    const { variable, stale } = await lookupVariable(alias.id, ctx);
    if (!variable) {
      ctx.notes.push(`"${styleName}": layer ${layer} ${field} is bound to a variable that no longer exists (${alias.id}).`);
      out.push({ layer, field, variableId: alias.id, variableName: "", variableSetId: "", variableSetName: "", stale: true, valuesByMode: {} });
      continue;
    }
    const info = await aliasInfo(variable);
    const binding: StyleBinding = {
      layer,
      field,
      variableId: info.targetVariableId,
      variableName: info.targetVariableName,
      variableSetId: info.targetVariableSetId,
      variableSetName: info.targetVariableSetName,
      valuesByMode: {},
    };
    if (stale) {
      binding.stale = true;
      ctx.notes.push(`"${styleName}": layer ${layer} ${field} is bound to deleted variable "${variable.name}".`);
    }
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    for (const mode of collection ? collection.modes : []) {
      const resolved = await resolveConcrete(variable, mode.modeId);
      if (resolved === null) {
        ctx.notes.push(`"${styleName}": "${variable.name}" has no resolvable value in mode "${mode.name}".`);
        continue;
      }
      binding.valuesByMode[mode.name] = formatValue(variable.resolvedType, resolved).value;
    }
    out.push(binding);
  }
  return out;
}

async function serializeStyles(kind: StyleKind, ctx: ExportContext): Promise<Record<string, unknown>> {
  const styles = await getLocalStyles(kind);
  const root: Record<string, unknown> = {};

  for (const s of styles) {
    const { type, value, extras } = serializeStyleValue(kind, s);
    const extensions: Record<string, unknown> = { "com.figma.styleId": s.id };
    if (extras) extensions["com.figma.textStyleExtras"] = extras;
    const bindings = await serializeStyleBindings(s.name, styleLayers(kind, s), ctx);
    if (bindings.length > 0) extensions["com.figma.boundVariables"] = bindings;

    const leaf: Record<string, unknown> = { $type: type, $value: value };
    if (s.description) leaf.$description = s.description;
    leaf.$extensions = extensions;

    setPath(root, s.name.split("/"), leaf);
  }

  return root;
}

/** Style-kind equivalent of computeMissingVariables — same reasoning applies. */
async function computeMissingStyles(
  kind: StyleKind,
  files: { filename: string; content: Record<string, any> }[],
): Promise<BaseStyle[]> {
  const allStyles = await getLocalStyles(kind);
  const importedNames = new Set<string>();
  for (const file of files) {
    for (const { path } of flattenTokens(file.content)) {
      importedNames.add(path.join("/"));
    }
  }
  return allStyles.filter((s) => !importedNames.has(s.name));
}

/**
 * Same ID-first-then-name matching and tombstone-safety as importFile,
 * adapted for styles: no modes (one value, not one per mode), no aliasing,
 * no scopes/codeSyntax (Style has neither) — Description and the kind-
 * specific value are the only fields that can change on an existing style.
 */
async function importStyleFile(
  kind: StyleKind,
  content: Record<string, any>,
  summary: ImportSummary,
): Promise<void> {
  const tokens = flattenTokens(content);
  const allStyles = await getLocalStyles(kind);
  const liveIds = new Set(allStyles.map((s) => s.id));
  const liveVariableIds = new Set((await figma.variables.getLocalVariablesAsync()).map((v) => v.id));

  /**
   * A layer array is only written if it's well-formed and every variable it
   * binds still exists — assigning a binding to a deleted variable would
   * leave the style pointing at a tombstone. Returns the reason to skip.
   */
  async function layerArrayProblem(value: unknown): Promise<string | null> {
    if (!Array.isArray(value)) return "value is not a layer array";
    const bad = findNonFinite(value, "", []);
    if (bad.length > 0) return `non-finite number at ${bad.join(", ")}`;
    for (const { layer, field, alias } of layerBindings(value)) {
      if (liveVariableIds.has(alias.id)) continue;
      const v = await figma.variables.getVariableByIdAsync(alias.id);
      if (!v || !v.remote) return `layer ${layer} ${field} is bound to missing variable ${alias.id}`;
    }
    return null;
  }

  for (const { path: tokenPath, node } of tokens) {
    const name = tokenPath.join("/");
    const extensions = node.$extensions ?? {};
    const styleId: string | undefined = extensions["com.figma.styleId"];

    let style: BaseStyle | null = null;
    if (styleId && liveIds.has(styleId)) {
      style = await figma.getStyleByIdAsync(styleId);
    }

    if (!style) {
      if (styleId) {
        summary.deletedNames.add(name);
      }
      const byName = allStyles.find((s) => s.name === name) ?? null;
      if (byName) {
        style = byName;
        if (styleId) {
          summary.notes.push(
            `"${name}": stale/removed style ID ${styleId} — matched an existing style by name instead (${byName.id}).`,
          );
        }
      }
    }

    const valueProblem = kind === "TEXT" ? null : await layerArrayProblem(node.$value);
    if (valueProblem) {
      summary.notes.push(`"${name}": value skipped — ${valueProblem}.${style ? "" : " Style not created."}`);
      if (!style) continue;
    }

    let isNew = false;
    let tokenChanged = false;
    if (!style) {
      isNew = true;
      style = createStyleOfKind(kind);
      style.name = name;
      allStyles.push(style);
      liveIds.add(style.id);
      summary.createdNames.add(name);
    } else if (style.name !== name) {
      style.name = name;
      summary.nameChanges++;
      tokenChanged = true;
    }

    if (kind === "TEXT") {
      const v = node.$value;
      const t = style as TextStyle;
      const desiredFontName: FontName = { family: v.fontFamily, style: v.fontWeight };
      await figma.loadFontAsync(desiredFontName);
      const valueChanged =
        !isNew &&
        (JSON.stringify(t.fontName) !== JSON.stringify(desiredFontName) ||
          t.fontSize !== v.fontSize ||
          JSON.stringify(t.letterSpacing) !== JSON.stringify(v.letterSpacing) ||
          JSON.stringify(t.lineHeight) !== JSON.stringify(v.lineHeight));
      t.fontName = desiredFontName;
      t.fontSize = v.fontSize;
      t.letterSpacing = v.letterSpacing;
      t.lineHeight = v.lineHeight;

      const extras = extensions["com.figma.textStyleExtras"];
      if (extras) {
        if (extras.paragraphIndent !== undefined) t.paragraphIndent = extras.paragraphIndent;
        if (extras.paragraphSpacing !== undefined) t.paragraphSpacing = extras.paragraphSpacing;
        if (extras.listSpacing !== undefined) t.listSpacing = extras.listSpacing;
        if (extras.textCase !== undefined) t.textCase = extras.textCase;
        if (extras.textDecoration !== undefined) t.textDecoration = extras.textDecoration;
        if (extras.leadingTrim !== undefined) t.leadingTrim = extras.leadingTrim;
        if (extras.hangingPunctuation !== undefined) t.hangingPunctuation = extras.hangingPunctuation;
        if (extras.hangingList !== undefined) t.hangingList = extras.hangingList;
      }
      if (valueChanged) {
        summary.valueChanges++;
        tokenChanged = true;
      }
    } else if (valueProblem) {
      // Reported above; leave the existing layers untouched.
    } else if (kind === "PAINT") {
      const p = style as PaintStyle;
      const desired = node.$value as Paint[];
      if (isNew || JSON.stringify(p.paints) !== JSON.stringify(desired)) {
        p.paints = desired;
        if (!isNew) {
          summary.valueChanges++;
          tokenChanged = true;
        }
      }
    } else if (kind === "EFFECT") {
      const e = style as EffectStyle;
      const desired = node.$value as Effect[];
      if (isNew || JSON.stringify(e.effects) !== JSON.stringify(desired)) {
        e.effects = desired;
        if (!isNew) {
          summary.valueChanges++;
          tokenChanged = true;
        }
      }
    } else {
      const g = style as GridStyle;
      const desired = node.$value as LayoutGrid[];
      if (isNew || JSON.stringify(g.layoutGrids) !== JSON.stringify(desired)) {
        g.layoutGrids = desired;
        if (!isNew) {
          summary.valueChanges++;
          tokenChanged = true;
        }
      }
    }

    const desiredDescription = node.$description ?? "";
    if (style.description !== desiredDescription) {
      style.description = desiredDescription;
      if (!isNew) {
        summary.descriptionChanges++;
        tokenChanged = true;
      }
    }

    if (!isNew && tokenChanged) {
      summary.updatedNames.add(name);
    }
  }
}

function emptyImportSummary(): ImportSummary {
  return {
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
}

function summaryToMessage(summary: ImportSummary) {
  return {
    created: Array.from(summary.createdNames),
    deleted: Array.from(summary.deletedNames),
    removed: Array.from(summary.removedNames),
    updated: Array.from(summary.updatedNames),
    nameChanges: summary.nameChanges,
    valueChanges: summary.valueChanges,
    scopeChanges: summary.scopeChanges,
    descriptionChanges: summary.descriptionChanges,
    codeSyntaxChanges: summary.codeSyntaxChanges,
    notes: Array.from(new Set(summary.notes)), // one token appears in several mode files
  };
}

/**
 * Hands export files to the UI for writing — unless any of them contains a
 * non-finite number, in which case nothing is written at all: a NaN in a
 * token file is a bug to fix, not a value to ship.
 */
function postExport(dir: string, files: { relativePath: string; content: unknown }[], ctx: ExportContext): void {
  const bad: string[] = [];
  for (const f of files) {
    for (const path of findNonFinite(f.content, "", [])) bad.push(`${f.relativePath}: ${path}`);
  }
  if (bad.length > 0) {
    figma.ui.postMessage({ type: "export-error", problems: bad });
    return;
  }
  figma.ui.postMessage({ type: "do-export", dir, files, notes: Array.from(new Set(ctx.notes)) });
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

    const ctx = await newExportContext();
    const files: { relativePath: string; content: unknown }[] = [];
    for (const target of targets) {
      for (const mode of target.modes) {
        const tree = await serializeCollectionMode(target, mode.modeId, ctx);
        files.push({
          relativePath: `${target.name.toLowerCase()}/${mode.name.toLowerCase()}.tokens.json`,
          content: tree,
        });
      }
    }

    postExport(msg.dir, files, ctx);
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
        notes: Array.from(new Set(summary.notes)),
      },
    });
    return;
  }

  if (msg.type === "export-styles") {
    const kinds = msg.kinds as StyleKind[];
    const ctx = await newExportContext();
    const files: { relativePath: string; content: unknown }[] = [];
    for (const kind of kinds) {
      const tree = await serializeStyles(kind, ctx);
      files.push({ relativePath: `styles/${kind.toLowerCase()}.tokens.json`, content: tree });
    }
    postExport(msg.dir, files, ctx);
    return;
  }

  if (msg.type === "check-import-styles") {
    const groups = msg.groups as { kind: StyleKind; files: { filename: string; content: Record<string, any> }[] }[];
    const missing: string[] = [];
    for (const group of groups) {
      const missingStyles = await computeMissingStyles(group.kind, group.files);
      for (const s of missingStyles) missing.push(s.name);
    }
    figma.ui.postMessage({ type: "import-check-result", missing });
    return;
  }

  if (msg.type === "import-styles") {
    const summary = emptyImportSummary();
    const groups = msg.groups as { kind: StyleKind; files: { filename: string; content: Record<string, any> }[] }[];

    for (const group of groups) {
      if (msg.deleteMissing) {
        const missingStyles = await computeMissingStyles(group.kind, group.files);
        for (const s of missingStyles) {
          summary.removedNames.add(s.name);
          s.remove();
        }
      }
      for (const file of group.files) {
        await importStyleFile(group.kind, file.content, summary);
      }
    }

    figma.ui.postMessage({ type: "import-result", summary: summaryToMessage(summary) });
  }
};

void sendCollections();

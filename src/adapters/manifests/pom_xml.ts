/**
 * Maven `pom.xml` parser.
 * Pure: takes a string, returns a Dependency[]. No I/O.
 *
 * v2.4 scope:
 *   - <dependencies> always — kind: 'runtime' for compile|runtime|provided,
 *     kind: 'dev' for test (only when opts.includeDev === true). 'system'
 *     scope is SKIPPED (system-scoped deps reference local file paths).
 *   - <dependencyManagement> read for VERSION inheritance only — entries are
 *     NOT emitted as deps themselves.
 *   - Property references (`${...}`) resolve via two-phase: build a map from
 *     <properties> + <project.{version,groupId,artifactId}> + <parent.{...}>
 *     built-ins, then substitute against deps. ONE indirection allowed
 *     (a -> b where b is a literal). Two-deep chains (a -> b -> c) and
 *     circular refs emit undefined (NOT a hang).
 *   - Aggregator pom (<packaging>pom</packaging> with <modules>) is NOT
 *     traversed here — that lives in `project_scanner.ts` (Task 5). The
 *     aggregator's own <dependencies> ARE parsed.
 *   - <scope>import</scope> BOM imports are NOT emitted as Dependency rows;
 *     they are surfaced via the sibling export `extractBomImports` (Task 2).
 *
 * Output is sorted by `name` (groupId:artifactId) for determinism.
 */

import { BomImport, Dependency, ManifestError, ParentCoords } from '../../types.js';
import { getLogger } from '../../logging.js';
import { parseXml } from '../xml.js';

interface PomDependency {
  groupId?: string;
  artifactId?: string;
  version?: string | number;
  scope?: string;
}

interface PomParent {
  groupId?: string;
  artifactId?: string;
  version?: string | number;
}

interface PomShape {
  project?: {
    groupId?: string;
    artifactId?: string;
    version?: string | number;
    packaging?: string;
    modules?: { module?: unknown };
    parent?: PomParent;
    properties?: Record<string, unknown>;
    dependencies?: { dependency?: PomDependency[] };
    dependencyManagement?: { dependencies?: { dependency?: PomDependency[] } };
  };
}

const PROPERTY_REF_RE = /^\$\{([^}]+)\}$/;

function buildPropertyMap(project: NonNullable<PomShape['project']>): Map<string, string> {
  const map = new Map<string, string>();

  // Phase 1: <properties> raw values.
  const props = project.properties;
  if (props && typeof props === 'object') {
    for (const [key, raw] of Object.entries(props)) {
      if (typeof raw === 'string') {
        map.set(key, raw);
      } else if (typeof raw === 'number') {
        map.set(key, String(raw));
      }
    }
  }

  // Phase 1b: Maven built-ins from <project>.
  const projectGroupId = typeof project.groupId === 'string' ? project.groupId : undefined;
  const projectArtifactId = typeof project.artifactId === 'string' ? project.artifactId : undefined;
  const projectVersion =
    typeof project.version === 'string' || typeof project.version === 'number'
      ? String(project.version)
      : undefined;
  if (projectGroupId !== undefined) map.set('project.groupId', projectGroupId);
  if (projectArtifactId !== undefined) map.set('project.artifactId', projectArtifactId);
  if (projectVersion !== undefined) map.set('project.version', projectVersion);

  // Phase 1c: Maven built-ins from <parent>.
  const parent = project.parent;
  if (parent && typeof parent === 'object') {
    const pg = typeof parent.groupId === 'string' ? parent.groupId : undefined;
    const pa = typeof parent.artifactId === 'string' ? parent.artifactId : undefined;
    const pv =
      typeof parent.version === 'string' || typeof parent.version === 'number'
        ? String(parent.version)
        : undefined;
    if (pg !== undefined) map.set('parent.groupId', pg);
    if (pa !== undefined) map.set('parent.artifactId', pa);
    if (pv !== undefined) map.set('parent.version', pv);
  }

  return map;
}

/**
 * Resolve a value that may be a property reference. Returns the literal value,
 * or undefined when:
 *   - the reference points to an unknown property
 *   - the reference points to another reference (more than one indirection)
 *   - the reference is part of a cycle
 *
 * v2.4: ONE indirection allowed — `a -> b` where `b` is a literal. Two-deep
 * chains (`a -> b -> c`) intentionally emit undefined to bound work and
 * defend against cycles without explicit cycle tracking.
 */
function resolveProperty(raw: string | undefined, map: Map<string, string>): string | undefined {
  if (raw === undefined) return undefined;
  const m = PROPERTY_REF_RE.exec(raw);
  if (!m) return raw;
  const key1 = m[1];
  const v1 = map.get(key1);
  if (v1 === undefined) return undefined;
  const m2 = PROPERTY_REF_RE.exec(v1);
  if (!m2) return v1;
  const key2 = m2[1];
  const v2 = map.get(key2);
  if (v2 === undefined) return undefined;
  // If v2 is itself a token, we've exceeded one indirection — bail to undefined.
  if (PROPERTY_REF_RE.test(v2)) return undefined;
  return v2;
}

export function parsePomXml(
  source: string,
  opts?: { includeDev?: boolean },
): Dependency[] {
  let parsed: unknown;
  try {
    parsed = parseXml(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestError('parse_error', `pom.xml is not valid XML: ${reason}`);
  }

  const project = (parsed as PomShape).project;
  if (!project || typeof project !== 'object') {
    throw new ManifestError('parse_error', 'pom.xml: missing <project> root element');
  }

  const propertyMap = buildPropertyMap(project);

  // Build version map from <dependencyManagement> for inheritance.
  // Property-resolved at insertion time so downstream lookups see literals.
  const versionByCoord = new Map<string, string>();
  const dmDeps = project.dependencyManagement?.dependencies?.dependency ?? [];
  for (const d of dmDeps) {
    const g = typeof d.groupId === 'string' ? d.groupId : '';
    const a = typeof d.artifactId === 'string' ? d.artifactId : '';
    const rawV = typeof d.version === 'string' ? d.version : undefined;
    if (!g || !a || rawV === undefined) continue;
    const resolved = resolveProperty(rawV, propertyMap);
    if (resolved !== undefined) versionByCoord.set(`${g}:${a}`, resolved);
  }

  const out: Dependency[] = [];
  const deps = project.dependencies?.dependency ?? [];
  for (const d of deps) {
    const g = typeof d.groupId === 'string' ? d.groupId : '';
    const a = typeof d.artifactId === 'string' ? d.artifactId : '';
    if (!g || !a) continue;

    const scope = typeof d.scope === 'string' ? d.scope.toLowerCase() : 'compile';
    if (scope === 'system') continue; // local-path; not a Maven coordinate
    const isTest = scope === 'test';
    if (isTest && opts?.includeDev !== true) continue;

    let declaredVersion: string | undefined;
    const rawVersion = typeof d.version === 'string' ? d.version : undefined;
    if (rawVersion !== undefined) {
      declaredVersion = resolveProperty(rawVersion, propertyMap);
    }
    if (declaredVersion === undefined) {
      // Inherit from <dependencyManagement> if available (already property-resolved).
      declaredVersion = versionByCoord.get(`${g}:${a}`);
    }

    out.push({
      name: `${g}:${a}`,
      ecosystem: 'maven',
      declaredVersion,
      kind: isTest ? 'dev' : 'runtime',
    });
  }

  out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return out;
}

/**
 * v2.4: extract `<scope>import</scope>` BOM dependencies from
 * `<dependencyManagement>`. Returns a side-channel array consumed by
 * the tool layer's `enrichWithBomImports`. The parser stays pure (no I/O);
 * this function reuses the same property-map machinery as `parsePomXml` so
 * BOM versions like `${spring-boot.version}` resolve consistently.
 *
 * Versions that cannot be resolved (still a `${...}` token after one
 * indirection) are dropped with one `pom_bom_import_unresolved_version`
 * warn-log per scan.
 */
export function extractBomImports(source: string): BomImport[] {
  let parsed: unknown;
  try {
    parsed = parseXml(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestError('parse_error', `pom.xml is not valid XML: ${reason}`);
  }

  const project = (parsed as PomShape).project;
  if (!project || typeof project !== 'object') {
    throw new ManifestError('parse_error', 'pom.xml: missing <project> root element');
  }

  const propertyMap = buildPropertyMap(project);
  const dmDeps = project.dependencyManagement?.dependencies?.dependency ?? [];

  const out: BomImport[] = [];
  let droppedAny = false;
  for (const d of dmDeps) {
    const scope = typeof d.scope === 'string' ? d.scope.toLowerCase() : '';
    if (scope !== 'import') continue;
    const groupId = typeof d.groupId === 'string' ? d.groupId : '';
    const artifactId = typeof d.artifactId === 'string' ? d.artifactId : '';
    if (!groupId || !artifactId) continue;
    const rawV = typeof d.version === 'string' ? d.version : undefined;
    const version = resolveProperty(rawV, propertyMap);
    if (version === undefined) {
      droppedAny = true;
      continue;
    }
    out.push({ groupId, artifactId, version });
  }

  if (droppedAny) {
    getLogger().warn('pom_bom_import_unresolved_version', {});
  }

  return out;
}

/**
 * v2.5: extract Maven `<parent>` coordinates from a child pom. Returns
 * `{ groupId, artifactId, version }` when ALL three are present and version
 * is not an unresolvable property reference; returns `null` otherwise.
 * Surfaced as a side-channel consumed by the tool layer's
 * `enrichWithParentPom`. The parser stays pure (no I/O); property refs in
 * the parent's `<version>` are resolved through the same property map as
 * `parsePomXml` (rare in practice — parent versions are usually literal —
 * but defended for symmetry).
 */
export function extractParentCoords(source: string): ParentCoords | null {
  let parsed: unknown;
  try {
    parsed = parseXml(source);
  } catch {
    return null;
  }
  const project = (parsed as PomShape).project;
  if (!project || typeof project !== 'object') return null;
  const parent = project.parent;
  if (!parent || typeof parent !== 'object') return null;

  const groupId = typeof parent.groupId === 'string' ? parent.groupId : '';
  const artifactId = typeof parent.artifactId === 'string' ? parent.artifactId : '';
  if (!groupId || !artifactId) return null;

  const rawVersion =
    typeof parent.version === 'string' ? parent.version
    : typeof parent.version === 'number' ? String(parent.version)
    : undefined;
  if (rawVersion === undefined) return null;

  const propertyMap = buildPropertyMap(project);
  const version = resolveProperty(rawVersion, propertyMap);
  if (version === undefined) return null;

  return { groupId, artifactId, version };
}

/**
 * v2.4: detect a Maven aggregator pom (`<packaging>pom</packaging>` with
 * `<modules>`). Returns the list of module directory names (relative to the
 * pom's dir) when the input IS an aggregator, or `null` otherwise. Pure: no
 * I/O. The scanner uses this to traverse module poms into a single dep set.
 */
export function extractAggregatorModules(source: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = parseXml(source);
  } catch {
    return null;
  }
  const project = (parsed as PomShape).project;
  if (!project || typeof project !== 'object') return null;
  if (project.packaging !== 'pom') return null;
  const modulesNode = project.modules?.module;
  if (!Array.isArray(modulesNode)) return null;
  const out: string[] = [];
  for (const m of modulesNode) {
    if (typeof m === 'string' && m.length > 0) out.push(m);
    else if (typeof m === 'number') out.push(String(m));
  }
  return out;
}

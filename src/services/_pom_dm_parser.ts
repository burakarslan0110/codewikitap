/**
 * @internal
 *
 * Shared `<dependencyManagement>` parser used by BOTH `bom_resolver.ts` and
 * `parent_resolver.ts`. Extracted in v2.5 so the two services don't
 * duplicate property-resolution + nested-BOM-detection logic.
 *
 * Pure: no I/O, no logging. Returns:
 *   - `versions`: literal `groupId:artifactId → version` from
 *     `<dependencyManagement>`, with `${...}` properties resolved against
 *     the POM's own `<properties>` + Maven built-ins (`project.*`, `parent.*`).
 *     Entries with unresolvable property refs are silently dropped.
 *   - `nestedBoms`: `<scope>import</scope>` entries surfaced as a side-channel
 *     so callers can walk them (recursive BOM walk in `bom_resolver`,
 *     parent's nested BOMs appended to `scan.bomImports` in `parent_resolver`).
 *
 * Two-phase property resolution: collect raw values first, then substitute
 * with one indirection ceiling (cycles emit undefined, no hang).
 */

import { BomImport } from '../types.js';
import { parseXml } from '../adapters/xml.js';

interface PomLikeShape {
  project?: {
    groupId?: string;
    artifactId?: string;
    version?: string | number;
    parent?: { groupId?: string; artifactId?: string; version?: string | number };
    properties?: Record<string, unknown>;
    dependencyManagement?: {
      dependencies?: {
        dependency?: Array<{
          groupId?: string;
          artifactId?: string;
          version?: string | number;
          scope?: string;
          type?: string;
        }>;
      };
    };
  };
}

const PROPERTY_REF_RE = /^\$\{([^}]+)\}$/;

function buildPropertyMap(project: NonNullable<PomLikeShape['project']>): Map<string, string> {
  const map = new Map<string, string>();
  const props = project.properties;
  if (props && typeof props === 'object') {
    for (const [key, raw] of Object.entries(props)) {
      if (typeof raw === 'string') map.set(key, raw);
      else if (typeof raw === 'number') map.set(key, String(raw));
    }
  }
  const projectGroupId = typeof project.groupId === 'string' ? project.groupId : undefined;
  const projectArtifactId = typeof project.artifactId === 'string' ? project.artifactId : undefined;
  const projectVersion =
    typeof project.version === 'string' || typeof project.version === 'number'
      ? String(project.version)
      : undefined;
  if (projectGroupId !== undefined) map.set('project.groupId', projectGroupId);
  if (projectArtifactId !== undefined) map.set('project.artifactId', projectArtifactId);
  if (projectVersion !== undefined) map.set('project.version', projectVersion);
  const parent = project.parent;
  if (parent && typeof parent === 'object') {
    if (typeof parent.groupId === 'string') map.set('parent.groupId', parent.groupId);
    if (typeof parent.artifactId === 'string') map.set('parent.artifactId', parent.artifactId);
    if (typeof parent.version === 'string') map.set('parent.version', parent.version);
    else if (typeof parent.version === 'number') map.set('parent.version', String(parent.version));
  }
  return map;
}

function resolveProperty(raw: string | undefined, map: Map<string, string>): string | undefined {
  if (raw === undefined) return undefined;
  const m = PROPERTY_REF_RE.exec(raw);
  if (!m) return raw;
  const v1 = map.get(m[1]);
  if (v1 === undefined) return undefined;
  const m2 = PROPERTY_REF_RE.exec(v1);
  if (!m2) return v1;
  const v2 = map.get(m2[1]);
  if (v2 === undefined) return undefined;
  if (PROPERTY_REF_RE.test(v2)) return undefined;
  return v2;
}

export interface ParsedDependencyManagement {
  /** Literal `groupId:artifactId → version` from <dependencyManagement>. */
  versions: Record<string, string>;
  /** `<scope>import</scope>` entries surfaced for callers to walk. */
  nestedBoms: BomImport[];
}

/**
 * Parse a POM XML's `<dependencyManagement>` block.
 *
 * Returns both the literal version map AND the nested BOM imports (as a
 * side-channel). v2.5 callers (bom_resolver + parent_resolver) consume the
 * shape directly. v2.4 behavior (drop nested BOMs) is preserved when the
 * caller ignores `nestedBoms`.
 */
export function parsePomDependencyManagement(pomText: string): ParsedDependencyManagement {
  const parsed = parseXml(pomText) as PomLikeShape;
  const project = parsed.project;
  if (!project) return { versions: {}, nestedBoms: [] };

  const propertyMap = buildPropertyMap(project);
  const dmDeps = project.dependencyManagement?.dependencies?.dependency ?? [];

  const versions: Record<string, string> = {};
  const nestedBoms: BomImport[] = [];

  for (const d of dmDeps) {
    const g = typeof d.groupId === 'string' ? d.groupId : '';
    const a = typeof d.artifactId === 'string' ? d.artifactId : '';
    if (!g || !a) continue;

    const rawV =
      typeof d.version === 'string' ? d.version
      : typeof d.version === 'number' ? String(d.version)
      : '';
    if (!rawV) continue;

    const resolved = resolveProperty(rawV, propertyMap);
    if (resolved === undefined) continue;

    const scope = typeof d.scope === 'string' ? d.scope.toLowerCase() : '';
    if (scope === 'import') {
      nestedBoms.push({ groupId: g, artifactId: a, version: resolved });
      continue;
    }
    versions[`${g}:${a}`] = resolved;
  }

  return { versions, nestedBoms };
}

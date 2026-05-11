/**
 * Gradle Version Catalog (`gradle/libs.versions.toml`) parser.
 * Pure: takes a string, returns a Dependency[]. No I/O.
 *
 * v2.3 + v2.5 scope:
 *   - [libraries] entries — emitted as `<group>:<artifact>` Maven coordinates,
 *     ecosystem: 'maven'. Four shapes supported: string form, module/version
 *     table, group/name/version table, version.ref alias.
 *   - [versions] — used for version.ref resolution; not emitted directly.
 *   - [plugins] (v2.5) — RESOLVED via the hardcoded `gradle_plugin_coords`
 *     table. Mapped plugins emit as Dependency rows with the plugin's
 *     declared version. Unmapped plugins emit a one-time
 *     `gradle_plugin_unmapped` warn per id per scan.
 *   - [bundles] — SKIPPED (bundles reference library aliases; UX convenience).
 *
 * `opts.includeDev` is accepted but has no effect — Gradle Version Catalogs
 * don't carry a runtime/test distinction (configurations live in build.gradle).
 *
 * Output is sorted by `name` for determinism.
 */

import TOML from '@iarna/toml';

import { Dependency, ManifestError } from '../../types.js';
import { getLogger } from '../../logging.js';
import { resolveGradlePluginCoord } from '../../data/gradle_plugin_coords.js';

interface VersionsCatalog {
  versions?: Record<string, unknown>;
  libraries?: Record<string, unknown>;
  plugins?: Record<string, unknown>;
  bundles?: Record<string, unknown>;
}

export function parseGradleVersionsToml(
  source: string,
  _opts?: { includeDev?: boolean },
): Dependency[] {
  let doc: VersionsCatalog;
  try {
    doc = TOML.parse(source) as VersionsCatalog;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestError('parse_error', `libs.versions.toml is not valid TOML: ${reason}`);
  }

  const log = getLogger();
  const versions = normalizeVersions(doc.versions);
  const libraries = doc.libraries ?? {};

  const out: Dependency[] = [];
  let unresolvedRefWarned = false;
  const warnedUnmappedPlugins = new Set<string>();

  for (const [, raw] of Object.entries(libraries)) {
    const parsed = parseLibraryEntry(raw, versions, () => {
      if (!unresolvedRefWarned) {
        log.warn('gradle_versions_ref_unresolved', {});
        unresolvedRefWarned = true;
      }
    });
    if (parsed) out.push(parsed);
  }

  // v2.5: resolve [plugins] via hardcoded coord map; unmapped warn-once.
  if (doc.plugins && Object.keys(doc.plugins).length > 0) {
    for (const [, raw] of Object.entries(doc.plugins)) {
      const dep = parsePluginEntry(raw, versions, log, warnedUnmappedPlugins, () => {
        if (!unresolvedRefWarned) {
          log.warn('gradle_versions_ref_unresolved', {});
          unresolvedRefWarned = true;
        }
      });
      if (dep) out.push(dep);
    }
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function parsePluginEntry(
  raw: unknown,
  versions: Map<string, string>,
  log: ReturnType<typeof getLogger>,
  warnedIds: Set<string>,
  onUnresolvedRef: () => void,
): Dependency | null {
  let pluginId: string | undefined;
  let declaredVersion: string | undefined;

  // Shape 1: string "id:version"
  if (typeof raw === 'string') {
    const idx = raw.indexOf(':');
    if (idx > 0) {
      pluginId = raw.slice(0, idx);
      declaredVersion = raw.slice(idx + 1) || undefined;
    } else {
      pluginId = raw;
    }
  } else if (raw && typeof raw === 'object') {
    const t = raw as Record<string, unknown>;
    if (typeof t.id === 'string') pluginId = t.id;
    const v = t.version;
    if (typeof v === 'string') {
      declaredVersion = v;
    } else if (v && typeof v === 'object') {
      const ref = (v as { ref?: unknown }).ref;
      if (typeof ref === 'string') {
        const resolved = versions.get(ref);
        if (resolved) declaredVersion = resolved;
        else onUnresolvedRef();
      }
    }
  }

  if (!pluginId) return null;

  const coord = resolveGradlePluginCoord(pluginId);
  if (!coord) {
    if (!warnedIds.has(pluginId)) {
      warnedIds.add(pluginId);
      log.warn('gradle_plugin_unmapped', { pluginId });
    }
    return null;
  }
  return {
    name: `${coord.groupId}:${coord.artifactId}`,
    ecosystem: 'maven',
    declaredVersion,
    kind: 'runtime',
  };
}

function normalizeVersions(versions: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!versions || typeof versions !== 'object') return map;
  for (const [k, v] of Object.entries(versions as Record<string, unknown>)) {
    if (typeof v === 'string') map.set(k, v);
  }
  return map;
}

function parseLibraryEntry(
  raw: unknown,
  versions: Map<string, string>,
  onUnresolvedRef: () => void,
): Dependency | null {
  // Shape 1: string "group:artifact:version"
  if (typeof raw === 'string') {
    const parts = raw.split(':');
    if (parts.length < 2) return null;
    const [group, artifact, version] = parts;
    if (!group || !artifact) return null;
    return {
      name: `${group}:${artifact}`,
      ecosystem: 'maven',
      declaredVersion: version || undefined,
      kind: 'runtime',
    };
  }

  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;

  // Resolve coordinate: either `module = "g:a"` OR `group + name`
  let group: string | undefined;
  let artifact: string | undefined;

  if (typeof t.module === 'string') {
    const idx = t.module.indexOf(':');
    if (idx > 0) {
      group = t.module.slice(0, idx);
      artifact = t.module.slice(idx + 1);
    }
  } else {
    if (typeof t.group === 'string') group = t.group;
    if (typeof t.name === 'string') artifact = t.name;
  }

  if (!group || !artifact) return null;

  // Resolve version: `version = "x"` OR `version.ref = "alias"` OR
  // `version = { ref = "alias" }` (the @iarna/toml shape for `version.ref`)
  let declaredVersion: string | undefined;
  const v = t.version;
  if (typeof v === 'string') {
    declaredVersion = v;
  } else if (v && typeof v === 'object') {
    const ref = (v as { ref?: unknown }).ref;
    if (typeof ref === 'string') {
      const resolved = versions.get(ref);
      if (resolved) {
        declaredVersion = resolved;
      } else {
        onUnresolvedRef();
      }
    }
  }

  return {
    name: `${group}:${artifact}`,
    ecosystem: 'maven',
    declaredVersion,
    kind: 'runtime',
  };
}

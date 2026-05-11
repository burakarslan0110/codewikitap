/**
 * .NET `*.csproj` parser.
 * Pure: takes a string, returns a Dependency[]. No I/O.
 *
 * v2.3 scope:
 *   - Walks Project.ItemGroup[].PackageReference[] entries.
 *   - Reads `@_Include` (name) and EITHER `@_Version` (attribute) OR a child
 *     <Version> element (alternate syntax). Missing version → undefined
 *     (resolved later by the scanner via Directory.Packages.props if present).
 *   - PrivateAssets="all" → kind: 'dev' (analyzers, source generators,
 *     SourceLink etc. — common .NET dev convention).
 *   - <Reference> and <ProjectReference> are SKIPPED (local assemblies / sibling
 *     projects, not NuGet packages).
 *   - Conditional ItemGroups (`@_Condition`) are NOT honored — all
 *     PackageReferences across all ItemGroups are aggregated, deduped by Include
 *     (first wins). Multi-target nuance is a known v2.3 imprecision.
 *
 * Output is sorted by `name` for determinism.
 */

import { Dependency, ManifestError } from '../../types.js';
import { parseXml } from '../xml.js';

interface CsprojRefAttr {
  '@_Include'?: string;
  '@_Version'?: string | number;
  '@_PrivateAssets'?: string;
  Version?: string | number;
}

interface CsprojShape {
  Project?: {
    ItemGroup?: Array<{
      PackageReference?: CsprojRefAttr[];
    }>;
  };
}

export function parseCsprojXml(
  source: string,
  opts?: { includeDev?: boolean },
): Dependency[] {
  let parsed: unknown;
  try {
    parsed = parseXml(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestError('parse_error', `csproj is not valid XML: ${reason}`);
  }

  const project = (parsed as CsprojShape).Project;
  if (!project || typeof project !== 'object') {
    throw new ManifestError('parse_error', 'csproj: missing <Project> root element');
  }

  const includeDev = opts?.includeDev === true;
  const seen = new Set<string>();
  const out: Dependency[] = [];

  const itemGroups = project.ItemGroup ?? [];
  for (const ig of itemGroups) {
    const refs = ig.PackageReference ?? [];
    for (const ref of refs) {
      const name = typeof ref['@_Include'] === 'string' ? ref['@_Include'] : '';
      if (!name) continue;
      if (seen.has(name)) continue;
      seen.add(name);

      const isDev = ref['@_PrivateAssets'] === 'all';
      if (isDev && !includeDev) continue;

      let declaredVersion: string | undefined;
      const attrV = ref['@_Version'];
      const childV = ref.Version;
      if (typeof attrV === 'string' || typeof attrV === 'number') {
        declaredVersion = String(attrV);
      } else if (typeof childV === 'string' || typeof childV === 'number') {
        declaredVersion = String(childV);
      }

      out.push({
        name,
        ecosystem: 'nuget',
        declaredVersion,
        kind: isDev ? 'dev' : 'runtime',
      });
    }
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

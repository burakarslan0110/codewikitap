/**
 * .NET Central Package Management (`Directory.Packages.props`) version-map
 * extractor. Pure: takes a string, returns a Map<packageName, version>.
 *
 * v2.3 scope: this is NOT a Dependency[] producer — it feeds the scanner's
 * CPM merge step which fills in `declaredVersion` for csproj-emitted deps.
 * Returns an empty map on missing/malformed input rather than throwing
 * (the scanner falls back to csproj-only versions in that case).
 */

import { ManifestError } from '../../types.js';
import { parseXml } from '../xml.js';

interface PropsRefAttr {
  '@_Include'?: string;
  '@_Version'?: string | number;
}

interface PropsShape {
  Project?: {
    ItemGroup?: Array<{
      PackageVersion?: PropsRefAttr[];
    }>;
  };
}

export function parseDirectoryPackagesProps(source: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = parseXml(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestError(
      'parse_error',
      `Directory.Packages.props is not valid XML: ${reason}`,
    );
  }

  const project = (parsed as PropsShape).Project;
  if (!project || typeof project !== 'object') {
    return new Map();
  }

  const map = new Map<string, string>();
  const itemGroups = project.ItemGroup ?? [];
  for (const ig of itemGroups) {
    const versions = ig.PackageVersion ?? [];
    for (const v of versions) {
      const name = typeof v['@_Include'] === 'string' ? v['@_Include'] : '';
      const version = v['@_Version'];
      if (!name) continue;
      if (typeof version === 'string' || typeof version === 'number') {
        // First wins for duplicates (defensive — uncommon in real CPM files).
        if (!map.has(name)) map.set(name, String(version));
      }
    }
  }

  return map;
}

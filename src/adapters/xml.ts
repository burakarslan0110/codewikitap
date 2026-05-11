/**
 * Shared XML parser. Used by Maven `pom.xml`, .NET `*.csproj`,
 * `Directory.Packages.props`, and the resolver's POM/nuspec parsing in
 * `src/services/repo_resolver.ts`. Configuration is shared so attribute prefix
 * (`@_`) and forced-array tag list stay consistent across the codebase.
 *
 * `isArray` forces single-element lists to remain arrays — without this,
 * a POM with one `<dependency>` would parse as `dependency: { ... }` instead
 * of `dependency: [{ ... }]`, breaking the iteration code in every parser.
 */

import { XMLParser } from 'fast-xml-parser';

const FORCE_ARRAY_TAGS = new Set([
  'dependency',
  'PackageReference',
  'PackageVersion',
  'module',
  'ItemGroup',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  trimValues: true,
  isArray: (name: string): boolean => FORCE_ARRAY_TAGS.has(name),
});

export function parseXml(source: string): unknown {
  return parser.parse(source);
}

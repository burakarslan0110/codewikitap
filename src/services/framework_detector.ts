/**
 * Framework detector (v0.6).
 *
 * Pure fn: walks a `Dependency[]` against `FRAMEWORK_SIGNATURES`, returns
 * one `FrameworkContext` per detected framework. Used by
 * `list_project_dependencies` to surface structured framework hints in tool
 * output (`manifests[i].frameworks`).
 *
 * Contracts:
 *   - Match: ecosystem-aware, name-exact OR prefix-with-trailing-asterisk.
 *     Substring matches are NEVER allowed (prevents `nextjs-bcrypt` →
 *     "next.js" false positives).
 *   - Dedup by `name`: multiple deps mapping to the same framework
 *     (`spring-boot-starter-web` + `spring-boot-starter-data-jpa` →
 *     Spring Boot once); first hit wins on `detectedFrom`.
 *   - No I/O, no async, no shared mutable state. Lineer scan, O(N × |signatures|).
 */

import { FRAMEWORK_SIGNATURES, type FrameworkSignature } from '../data/framework_signatures.js';
import type { Dependency, FrameworkContext, ManifestType } from '../types.js';

/**
 * Returns one `FrameworkContext` per distinct framework detected in `deps`.
 *
 * @param deps - the dependencies to scan.
 * @param manifestType - manifest the deps came from; embedded into
 *   `detectedFrom` as `<manifestType>:dependencies.<dep-name>`.
 */
export function detectFrameworks(
  deps: Dependency[],
  manifestType: ManifestType | string,
): FrameworkContext[] {
  const out = new Map<string, FrameworkContext>();
  for (const dep of deps) {
    const sig = matchSignature(dep, FRAMEWORK_SIGNATURES);
    if (!sig) continue;
    if (out.has(sig.name)) continue;
    out.set(sig.name, {
      name: sig.name,
      confidence: sig.confidence,
      sourceRepo: sig.sourceRepo,
      detectedFrom: `${manifestType}:dependencies.${dep.name}`,
    });
  }
  return Array.from(out.values());
}

function matchSignature(
  dep: Dependency,
  signatures: readonly FrameworkSignature[],
): FrameworkSignature | null {
  for (const sig of signatures) {
    if (sig.ecosystem !== dep.ecosystem) continue;
    if (sig.matchKind === 'exact') {
      if (dep.name === sig.pattern) return sig;
      continue;
    }
    // 'prefix' — pattern ends with `*`. Strip the asterisk; require strict
    // prefix match (the prefix itself counts as a match).
    if (!sig.pattern.endsWith('*')) continue;
    const prefix = sig.pattern.slice(0, -1);
    if (dep.name.startsWith(prefix)) return sig;
  }
  return null;
}

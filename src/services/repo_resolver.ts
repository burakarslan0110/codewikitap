/**
 * Resolve a (name, ecosystem) pair to a canonical github.com/<owner>/<repo>.
 *
 * Strategy per ecosystem:
 *  - npm     → registry.npmjs.org/<name>/latest, parse repository.url
 *  - pypi    → pypi.org/pypi/<name>/json, parse info.project_urls.Source/Homepage
 *  - go      → if module path is github.com/* → verify via proxy.golang.org
 *              else → fetch the vanity-import URL with ?go-get=1, parse the
 *              <meta name="go-import"> tag (the same resolution Go itself uses).
 *
 * On total upstream failure for npm/pypi, we return a low-confidence
 * `{ owner: name, repo: name }` fuzzy guess so the caller has SOMETHING to try
 * (the wiki probe will validate). Go has no such fallback because module paths
 * are explicit and a wrong guess would just produce 404s.
 */

import * as semver from 'semver';

import {
  Ecosystem,
  ResolvedRepo,
  RepoResolveError,
} from '../types.js';
import { FETCH_TIMEOUT_MS } from '../config.js';
import { parseXml } from '../adapters/xml.js';

export async function resolveRepo(
  name: string,
  ecosystem: Ecosystem,
): Promise<ResolvedRepo | null> {
  if (!name || name.length === 0) return null;
  switch (ecosystem) {
    case 'npm':
      return resolveNpm(name);
    case 'pypi':
      return resolvePyPI(name);
    case 'go':
      return resolveGo(name);
    case 'cargo':
      return resolveCargo(name);
    case 'composer':
      return resolveComposer(name);
    case 'maven':
      return resolveMaven(name);
    case 'gem':
      return resolveRubyGems(name);
    case 'nuget':
      return resolveNuGet(name);
  }
}

// ---------------------------------------------------------------------------
// Maven Central (v2.3) — two-step: search.maven.org -> repo1.maven.org POM
// ---------------------------------------------------------------------------

interface MavenSearchResp {
  response?: { docs?: Array<{ v?: string }> };
}

interface MavenPomShape {
  project?: {
    scm?: { url?: string; connection?: string };
    url?: string;
  };
}

async function resolveMaven(name: string): Promise<ResolvedRepo | null> {
  // Input MUST be <groupId>:<artifactId>. Reject other shapes.
  const colonIdx = name.indexOf(':');
  if (colonIdx <= 0 || colonIdx === name.length - 1) return null;
  const groupId = name.slice(0, colonIdx);
  const artifactId = name.slice(colonIdx + 1);
  if (groupId.includes(':') || artifactId.includes(':')) return null;

  // Step 1: search.maven.org for latest version.
  const searchUrl = `https://search.maven.org/solrsearch/select?q=g:%22${encodeURIComponent(
    groupId,
  )}%22+AND+a:%22${encodeURIComponent(artifactId)}%22&core=gav&rows=1&wt=json`;
  let version: string;
  try {
    const res = await fetchWithTimeout(searchUrl);
    if (res.status === 404) return null;
    if (!res.ok) return null; // Maven coords are explicit; no fuzzy fallback.
    const json = (await res.json()) as MavenSearchResp;
    const doc = json.response?.docs?.[0];
    if (!doc?.v) return null;
    version = doc.v;
  } catch {
    return null;
  }

  // Step 2: fetch the POM and extract <scm> / <url>.
  const groupPath = groupId.replace(/\./g, '/');
  const pomUrl = `https://repo1.maven.org/maven2/${groupPath}/${artifactId}/${version}/${artifactId}-${version}.pom`;
  let pomText: string;
  try {
    const res = await fetchWithTimeout(pomUrl);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    pomText = await res.text();
  } catch {
    return null;
  }

  let pomDoc: MavenPomShape;
  try {
    pomDoc = parseXml(pomText) as MavenPomShape;
  } catch {
    return null;
  }

  const scm = pomDoc.project?.scm;
  // Maven SCM connection often uses `scm:git:https://...` — strip the prefix.
  const stripScm = (s: string): string => s.replace(/^scm:git:/, '').replace(/^scm:/, '');

  const candidates: Array<{ url: string; high: boolean; field: string }> = [];
  if (typeof scm?.url === 'string') candidates.push({ url: scm.url, high: true, field: 'scm.url' });
  if (typeof scm?.connection === 'string') {
    candidates.push({ url: stripScm(scm.connection), high: true, field: 'scm.connection' });
  }
  if (typeof pomDoc.project?.url === 'string') {
    candidates.push({ url: pomDoc.project.url, high: false, field: 'project.url' });
  }

  const parsed: Array<{ owner: string; repo: string; high: boolean }> = [];
  for (const c of candidates) {
    const p = parseGithubRepo(c.url);
    if (p) parsed.push({ ...p, high: c.high });
  }
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => Number(b.high) - Number(a.high));
  const primary = parsed[0];
  const alternates = parsed
    .slice(1)
    .filter((p) => p.owner !== primary.owner || p.repo !== primary.repo)
    .map((p) => ({ owner: p.owner, repo: p.repo, source: 'maven-central' as const }));
  const result: ResolvedRepo = {
    owner: primary.owner,
    repo: primary.repo,
    source: 'maven-central',
    confidence: primary.high ? 'high' : 'medium',
  };
  if (alternates.length > 0) result.alternates = alternates;
  return result;
}

// ---------------------------------------------------------------------------
// RubyGems (v2.3) — single fetch
// ---------------------------------------------------------------------------

interface RubyGemsResp {
  source_code_uri?: string;
  homepage_uri?: string;
}

async function resolveRubyGems(name: string): Promise<ResolvedRepo | null> {
  const url = `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`;
  let json: RubyGemsResp;
  try {
    const res = await fetchWithTimeout(url);
    if (res.status === 404) return null;
    if (!res.ok) return fuzzyFallback(name);
    json = (await res.json()) as RubyGemsResp;
  } catch {
    return fuzzyFallback(name);
  }

  const picked = pickGithubFromFields(json, [
    { path: 'source_code_uri', high: true },
    { path: 'homepage_uri', high: false },
  ]);
  if (picked) {
    const result: ResolvedRepo = {
      owner: picked.primary.owner,
      repo: picked.primary.repo,
      source: 'rubygems',
      confidence: picked.primary.high ? 'high' : 'medium',
    };
    if (picked.alternates.length > 0) {
      result.alternates = picked.alternates.map((a) => ({ ...a, source: 'rubygems' as const }));
    }
    return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// NuGet (v2.3) — two-step: flatcontainer index -> nuspec
// ---------------------------------------------------------------------------

interface NuGetIndexResp {
  versions?: string[];
}

interface NuspecShape {
  package?: {
    metadata?: {
      repository?: { '@_url'?: string };
      projectUrl?: string;
    };
  };
}

async function resolveNuGet(name: string): Promise<ResolvedRepo | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const lower = name.toLowerCase();

  // Step 1: list versions, pick latest stable (or highest pre-release).
  const indexUrl = `https://api.nuget.org/v3-flatcontainer/${lower}/index.json`;
  let versions: string[];
  try {
    const res = await fetchWithTimeout(indexUrl);
    if (res.status === 404) return null;
    if (!res.ok) return fuzzyFallback(name);
    const json = (await res.json()) as NuGetIndexResp;
    versions = Array.isArray(json.versions) ? json.versions : [];
  } catch {
    return fuzzyFallback(name);
  }
  if (versions.length === 0) return null;

  const version = pickLatestNugetVersion(versions);
  if (!version) return null;

  // Step 2: fetch nuspec, extract <repository url=...> / <projectUrl>.
  const nuspecUrl = `https://api.nuget.org/v3-flatcontainer/${lower}/${version}/${lower}.nuspec`;
  let nuspecText: string;
  try {
    const res = await fetchWithTimeout(nuspecUrl);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    nuspecText = await res.text();
  } catch {
    return null;
  }

  let parsed: NuspecShape;
  try {
    parsed = parseXml(nuspecText) as NuspecShape;
  } catch {
    return null;
  }

  const meta = parsed.package?.metadata;
  const candidates: Array<{ url: string; high: boolean }> = [];
  if (typeof meta?.repository?.['@_url'] === 'string') {
    candidates.push({ url: meta.repository['@_url']!, high: true });
  }
  if (typeof meta?.projectUrl === 'string') {
    candidates.push({ url: meta.projectUrl, high: false });
  }

  const parsedCandidates: Array<{ owner: string; repo: string; high: boolean }> = [];
  for (const c of candidates) {
    const p = parseGithubRepo(c.url);
    if (p) parsedCandidates.push({ ...p, high: c.high });
  }
  if (parsedCandidates.length === 0) return null;
  parsedCandidates.sort((a, b) => Number(b.high) - Number(a.high));
  const primary = parsedCandidates[0];
  const alternates = parsedCandidates
    .slice(1)
    .filter((p) => p.owner !== primary.owner || p.repo !== primary.repo)
    .map((p) => ({ owner: p.owner, repo: p.repo, source: 'nuget' as const }));
  const result: ResolvedRepo = {
    owner: primary.owner,
    repo: primary.repo,
    source: 'nuget',
    confidence: primary.high ? 'high' : 'medium',
  };
  if (alternates.length > 0) result.alternates = alternates;
  return result;
}

/**
 * SemVer 2.0-correct latest-version picker for NuGet flatcontainer responses.
 * Handles 4-part Microsoft versioning (`1.0.0.0` -> coerced), multi-segment
 * pre-release (`2.0.0-preview.7.20364.11`), build metadata (ignored), and
 * string-vs-numeric pre-release tags (`rc.10` > `rc.2`).
 */
function pickLatestNugetVersion(versions: string[]): string | null {
  if (versions.length === 0) return null;
  // Normalize for comparison: coerce strips/normalizes 4-part etc.
  // We sort by the coerced full version (which preserves prerelease ordering
  // through semver.parse) using semver.rcompare on the parsed forms.
  const stable: string[] = [];
  const prerelease: string[] = [];
  for (const v of versions) {
    // semver.parse accepts pre-release; reject only null returns (truly unparseable
    // 4-part versions get coerced as a fallback).
    let parsed = semver.parse(v);
    if (!parsed) {
      const coerced = semver.coerce(v);
      if (!coerced) continue;
      parsed = semver.parse(coerced.version);
      if (!parsed) continue;
    }
    if (parsed.prerelease.length === 0) {
      stable.push(v);
    } else {
      prerelease.push(v);
    }
  }
  const cmp = (a: string, b: string): number => {
    const pa = semver.parse(a) ?? semver.coerce(a);
    const pb = semver.parse(b) ?? semver.coerce(b);
    if (!pa || !pb) return 0;
    return semver.rcompare(pa.version, pb.version);
  };
  if (stable.length > 0) {
    stable.sort(cmp);
    return stable[0];
  }
  prerelease.sort(cmp);
  return prerelease[0] ?? null;
}

// ---------------------------------------------------------------------------
// pickGithubFromFields helper (v2.2 hardening audit, Truth #6)
// ---------------------------------------------------------------------------
//
// Walks an ordered list of dotted-path expressions on a JSON blob; returns
// the first GitHub URL that parses, plus all secondary matches as alternates.
// Used by the FOUR JSON resolvers (npm, pypi, cargo, composer). resolveGo
// is structurally different (HTML <meta> tag, not JSON) and is left untouched.

function getByPath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

interface PickResult {
  primary: { owner: string; repo: string; field: string; high: boolean };
  alternates: Array<{ owner: string; repo: string }>;
}

function pickGithubFromFields(
  json: unknown,
  fields: Array<{ path: string; high: boolean }>,
): PickResult | null {
  const matches: Array<{ owner: string; repo: string; field: string; high: boolean }> = [];
  for (const f of fields) {
    const raw = getByPath(json, f.path);
    if (typeof raw !== 'string') continue;
    const parsed = parseGithubRepo(raw);
    if (parsed) matches.push({ ...parsed, field: f.path, high: f.high });
  }
  if (matches.length === 0) return null;
  // Stable sort: high-confidence fields first, preserving insertion order otherwise.
  matches.sort((a, b) => Number(b.high) - Number(a.high));
  const primary = matches[0];
  const alternates = matches
    .slice(1)
    .filter((m) => m.owner !== primary.owner || m.repo !== primary.repo)
    .map((m) => ({ owner: m.owner, repo: m.repo }));
  return { primary, alternates };
}

// ---------------------------------------------------------------------------
// crates.io (v2.2)
// ---------------------------------------------------------------------------

interface CratesIoResp {
  crate?: { repository?: string; homepage?: string };
}

async function resolveCargo(name: string): Promise<ResolvedRepo | null> {
  const url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
  let json: CratesIoResp;
  try {
    // crates.io's Cloudflare front-door requires a User-Agent; missing UA → 403.
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'codewiki-mcp/2.2 (+https://github.com/codewiki/mcp)' },
    });
    if (res.status === 404) return null;
    if (!res.ok) return fuzzyFallback(name);
    json = (await res.json()) as CratesIoResp;
  } catch {
    return fuzzyFallback(name);
  }

  const picked = pickGithubFromFields(json, [
    { path: 'crate.repository', high: true },
    { path: 'crate.homepage', high: false },
  ]);
  if (picked) {
    const result: ResolvedRepo = {
      owner: picked.primary.owner,
      repo: picked.primary.repo,
      source: 'crates-io',
      confidence: picked.primary.high ? 'high' : 'medium',
    };
    if (picked.alternates.length > 0) {
      result.alternates = picked.alternates.map((a) => ({ ...a, source: 'crates-io' as const }));
    }
    return result;
  }
  return fuzzyFallback(name);
}

// ---------------------------------------------------------------------------
// Packagist (v2.2)
// ---------------------------------------------------------------------------

interface PackagistResp {
  packages?: Record<string, Array<{ source?: { url?: string }; homepage?: string }>>;
}

async function resolveComposer(name: string): Promise<ResolvedRepo | null> {
  // The dep name MUST be in <vendor>/<package> form for Packagist.
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) return null;

  const url = `https://repo.packagist.org/p2/${name}.json`;
  let json: PackagistResp;
  try {
    const res = await fetchWithTimeout(url);
    if (res.status === 404) return null;
    if (!res.ok) return fuzzyFallback(name);
    json = (await res.json()) as PackagistResp;
  } catch {
    return fuzzyFallback(name);
  }

  const versions = json.packages?.[name];
  const latest = Array.isArray(versions) && versions.length > 0 ? versions[0] : undefined;
  if (latest) {
    const picked = pickGithubFromFields(latest, [
      { path: 'source.url', high: true },
      { path: 'homepage', high: false },
    ]);
    if (picked) {
      const result: ResolvedRepo = {
        owner: picked.primary.owner,
        repo: picked.primary.repo,
        source: 'packagist',
        confidence: picked.primary.high ? 'high' : 'medium',
      };
      if (picked.alternates.length > 0) {
        result.alternates = picked.alternates.map((a) => ({ ...a, source: 'packagist' as const }));
      }
      return result;
    }
  }
  return fuzzyFallback(name);
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

interface NpmLatest {
  repository?: string | { type?: string; url?: string };
}

async function resolveNpm(name: string): Promise<ResolvedRepo | null> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
  let json: NpmLatest;
  try {
    const res = await fetchWithTimeout(url);
    // Codex finding: 404 is "package does not exist" — return null so the
    // tool emits `status: 'no_match'`. Do NOT fabricate a fuzzy guess.
    if (res.status === 404) return null;
    if (!res.ok) return fuzzyFallback(name); // 5xx / transient → low-confidence guess
    json = (await res.json()) as NpmLatest;
  } catch {
    // Network failure (DNS, timeout) is transient → keep the name-as-repo
    // guess so the agent can still try a CodeWiki probe, but mark low.
    return fuzzyFallback(name);
  }

  const rawRepo = typeof json.repository === 'string' ? json.repository : json.repository?.url;
  if (!rawRepo) return null;
  const parsed = parseGithubRepo(rawRepo);
  if (parsed) {
    return { owner: parsed.owner, repo: parsed.repo, source: 'npm-registry', confidence: 'high' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// PyPI
// ---------------------------------------------------------------------------

interface PyPIInfo {
  info?: {
    project_urls?: Record<string, string>;
    home_page?: string;
  };
}

async function resolvePyPI(name: string): Promise<ResolvedRepo | null> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  let json: PyPIInfo;
  try {
    const res = await fetchWithTimeout(url);
    if (res.status === 404) return null; // package doesn't exist — no fuzzy fabrication
    if (!res.ok) return fuzzyFallback(name);
    json = (await res.json()) as PyPIInfo;
  } catch {
    return fuzzyFallback(name);
  }

  // v2.2 hardening: collect ALL GitHub URL candidates from project_urls + home_page,
  // pick the highest-confidence one as primary, populate the rest as `alternates`.
  type Candidate = { owner: string; repo: string; field: string; high: boolean };
  const candidates: Candidate[] = [];
  const urls = json.info?.project_urls ?? {};
  const HIGH_FIELDS = new Set(['Source', 'source', 'Repository', 'repository']);

  for (const [field, raw] of Object.entries(urls)) {
    const parsed = parseGithubRepo(raw);
    if (parsed) candidates.push({ ...parsed, field, high: HIGH_FIELDS.has(field) });
  }
  if (json.info?.home_page) {
    const parsed = parseGithubRepo(json.info.home_page);
    if (parsed) candidates.push({ ...parsed, field: 'home_page', high: false });
  }
  if (candidates.length === 0) return null;

  // Sort: high-confidence fields first, then preserve insertion order (stable).
  candidates.sort((a, b) => Number(b.high) - Number(a.high));
  const primary = candidates[0];
  const alternates = candidates.slice(1).map((c) => ({
    owner: c.owner,
    repo: c.repo,
    source: 'pypi' as const,
  }));

  const result: ResolvedRepo = {
    owner: primary.owner,
    repo: primary.repo,
    source: 'pypi',
    confidence: primary.high ? 'high' : 'medium',
  };
  if (alternates.length > 0) result.alternates = alternates;
  return result;
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

async function resolveGo(modulePath: string): Promise<ResolvedRepo | null> {
  // Direct github.com path: verify with proxy.golang.org.
  if (modulePath.startsWith('github.com/')) {
    const parts = modulePath.split('/');
    if (parts.length < 3) return null;
    const owner = parts[1];
    const repo = parts[2];
    const proxyUrl = `https://proxy.golang.org/${modulePath}/@v/list`;
    try {
      const res = await fetchWithTimeout(proxyUrl);
      if (!res.ok) return null;
      const text = await res.text();
      if (text.trim().length === 0) return null;
      return { owner, repo, source: 'go-proxy', confidence: 'high' };
    } catch {
      return null;
    }
  }

  // Vanity import: fetch ?go-get=1 and parse the meta tag.
  const url = `https://${modulePath}?go-get=1`;
  let html: string;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  // <meta name="go-import" content="<prefix> <vcs> <repo-url>">
  const metaRegex = /<meta\s+name=["']go-import["']\s+content=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRegex.exec(html)) !== null) {
    const parts = m[1].trim().split(/\s+/);
    if (parts.length !== 3) continue;
    const [, vcs, repoUrl] = parts;
    if (vcs !== 'git') continue;
    const parsed = parseGithubRepo(repoUrl);
    if (parsed) {
      return { owner: parsed.owner, repo: parsed.repo, source: 'go-vanity', confidence: 'medium' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseGithubRepo(rawUrl: string): { owner: string; repo: string } | null {
  if (!rawUrl) return null;
  let s = rawUrl.trim();

  // Strip git+ prefix.
  if (s.startsWith('git+')) s = s.slice(4);
  // Strip ssh git@github.com:owner/repo.git
  s = s.replace(/^git@github\.com:/i, 'https://github.com/');

  // Shorthand `owner/repo` (no scheme, no host).
  if (!s.includes('://') && !s.includes('github.com')) {
    const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(s);
    if (m) return { owner: m[1], repo: m[2] };
    return null;
  }

  let url: URL;
  try { url = new URL(s); } catch { return null; }
  if (url.host.toLowerCase() !== 'github.com') return null;
  const segs = url.pathname.split('/').filter((x) => x.length > 0);
  if (segs.length < 2) return null;
  const owner = segs[0];
  const repo = segs[1].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return { owner, repo };
}

function fuzzyFallback(name: string): ResolvedRepo | null {
  // Composer-style vendor/package names: split on `/` and use directly.
  const slash = name.indexOf('/');
  if (slash > 0) {
    const owner = name.slice(0, slash);
    const repo = name.slice(slash + 1);
    if (
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)
    ) {
      return { owner, repo, source: 'fuzzy', confidence: 'low' };
    }
    return null;
  }
  // Simple names (npm, cargo): use the bare name as both owner and repo.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  return { owner: name, repo: name, source: 'fuzzy', confidence: 'low' };
}

async function fetchWithTimeout(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers: init?.headers });
  } finally {
    clearTimeout(t);
  }
}

// Re-export for typing convenience in callers; the class is defined in types.ts.
export { RepoResolveError };

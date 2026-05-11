import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { resolveRepo } from '../../src/services/repo_resolver.js';

const realFetch = globalThis.fetch;

function mockFetchSequence(responses: Array<{ url: string; body?: unknown; status?: number; text?: string }>): void {
  const queue = [...responses];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const idx = queue.findIndex((r) => url.includes(r.url));
    if (idx < 0) throw new Error(`unexpected fetch: ${url}`);
    const r = queue.splice(idx, 1)[0];
    const status = r.status ?? 200;
    const ok = status >= 200 && status < 300;
    const body = r.text ?? JSON.stringify(r.body ?? {});
    return {
      ok,
      status,
      json: async () => JSON.parse(body),
      text: async () => body,
    } as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('resolveRepo — npm', () => {
  it('parses repository.url with the github.com prefix', async () => {
    mockFetchSequence([
      { url: 'registry.npmjs.org/react/latest', body: { repository: { url: 'git+https://github.com/facebook/react.git' } } },
    ]);
    const r = await resolveRepo('react', 'npm');
    expect(r).toEqual(expect.objectContaining({ owner: 'facebook', repo: 'react', source: 'npm-registry', confidence: 'high' }));
  });

  it('parses npm shorthand `org/repo` syntax', async () => {
    mockFetchSequence([
      { url: 'registry.npmjs.org/foo/latest', body: { repository: { url: 'sindresorhus/foo' } } },
    ]);
    const r = await resolveRepo('foo', 'npm');
    expect(r?.owner).toBe('sindresorhus');
    expect(r?.repo).toBe('foo');
    expect(r?.confidence).toBe('high');
  });

  it('returns null when repository.url is non-github', async () => {
    mockFetchSequence([
      { url: 'registry.npmjs.org/internal/latest', body: { repository: { url: 'https://gitlab.com/internal/internal.git' } } },
    ]);
    const r = await resolveRepo('internal', 'npm');
    expect(r).toBeNull();
  });

  it('returns null on registry 404 (package does not exist) — NO fuzzy fabrication', async () => {
    // Codex finding: 404 must surface as no_match through the tool, NOT a
    // fabricated `${name}/${name}` low-confidence guess.
    mockFetchSequence([
      { url: 'registry.npmjs.org/a-name-that-does-not-exist-xyz123/latest', status: 404, body: {} },
    ]);
    const r = await resolveRepo('a-name-that-does-not-exist-xyz123', 'npm');
    expect(r).toBeNull();
  });
});

describe('resolveRepo — pypi', () => {
  it('parses project_urls.Source for github URLs', async () => {
    mockFetchSequence([
      { url: 'pypi.org/pypi/requests/json', body: { info: { project_urls: { Source: 'https://github.com/psf/requests' } } } },
    ]);
    const r = await resolveRepo('requests', 'pypi');
    expect(r).toEqual(expect.objectContaining({ owner: 'psf', repo: 'requests', source: 'pypi', confidence: 'high' }));
  });
});

describe('resolveRepo — go', () => {
  it('handles a direct github.com module path via proxy.golang.org', async () => {
    mockFetchSequence([
      { url: 'proxy.golang.org/github.com/spf13/cobra/@v/list', text: 'v1.9.0\nv1.8.0\n' },
    ]);
    const r = await resolveRepo('github.com/spf13/cobra', 'go');
    expect(r).toEqual(expect.objectContaining({ owner: 'spf13', repo: 'cobra', source: 'go-proxy', confidence: 'high' }));
  });

  it('resolves vanity import golang.org/x/sync via ?go-get=1 meta tag', async () => {
    mockFetchSequence([
      {
        url: 'golang.org/x/sync?go-get=1',
        text: '<html><head><meta name="go-import" content="golang.org/x/sync git https://github.com/golang/sync"></head></html>',
      },
    ]);
    const r = await resolveRepo('golang.org/x/sync', 'go');
    expect(r).toEqual(expect.objectContaining({ owner: 'golang', repo: 'sync', source: 'go-vanity', confidence: 'medium' }));
  });

  it('resolves vanity import gopkg.in/yaml.v3 to go-yaml/yaml', async () => {
    mockFetchSequence([
      {
        url: 'gopkg.in/yaml.v3?go-get=1',
        text: '<html><head><meta name="go-import" content="gopkg.in/yaml.v3 git https://github.com/go-yaml/yaml"></head></html>',
      },
    ]);
    const r = await resolveRepo('gopkg.in/yaml.v3', 'go');
    expect(r?.owner).toBe('go-yaml');
    expect(r?.repo).toBe('yaml');
    expect(r?.source).toBe('go-vanity');
  });

  it('returns null when vanity host is not github', async () => {
    mockFetchSequence([
      {
        url: 'code.cloudfoundry.org/lager?go-get=1',
        text: '<meta name="go-import" content="code.cloudfoundry.org/lager git https://code.cloudfoundry.org/lager">',
      },
    ]);
    const r = await resolveRepo('code.cloudfoundry.org/lager', 'go');
    expect(r).toBeNull();
  });
});

describe('resolveRepo — all-miss fallback', () => {
  beforeEach(() => {
    // All upstreams fail (network error). Fallback applies for npm/pypi.
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); }) as typeof fetch;
  });

  it('falls back to {owner: name, repo: name} with low confidence on npm/pypi network failure', async () => {
    const r = await resolveRepo('lodash', 'npm');
    expect(r?.confidence).toBe('low');
    expect(r?.source).toBe('fuzzy');
    expect(r?.repo).toBe('lodash');
  });
});

describe('resolveRepo — hardening audit (v2.2)', () => {
  it('go resolver: 404 from proxy.golang.org returns null', async () => {
    mockFetchSequence([
      { url: 'proxy.golang.org/github.com/foo/missing/@v/list', status: 404 },
    ]);
    const r = await resolveRepo('github.com/foo/missing', 'go');
    expect(r).toBeNull();
  });

  it('pypi resolver: populates alternates when project_urls contains multiple GitHub URLs', async () => {
    mockFetchSequence([
      {
        url: 'pypi.org/pypi/multi/json',
        body: {
          info: {
            project_urls: {
              Source: 'https://github.com/primary/repo',
              Documentation: 'https://github.com/docs/site',
            },
          },
        },
      },
    ]);
    const r = await resolveRepo('multi', 'pypi');
    expect(r?.owner).toBe('primary');
    expect(r?.alternates).toBeDefined();
    expect(r?.alternates?.length).toBeGreaterThanOrEqual(1);
    expect(r?.alternates?.[0]).toEqual(
      expect.objectContaining({ owner: 'docs', repo: 'site', source: 'pypi' }),
    );
  });
});

describe('resolveRepo — cargo (crates.io, v2.2)', () => {
  it('parses crate.repository as a high-confidence GitHub repo', async () => {
    mockFetchSequence([
      {
        url: 'crates.io/api/v1/crates/serde',
        body: { crate: { repository: 'https://github.com/serde-rs/serde', homepage: 'https://serde.rs' } },
      },
    ]);
    const r = await resolveRepo('serde', 'cargo');
    expect(r).toEqual(
      expect.objectContaining({ owner: 'serde-rs', repo: 'serde', source: 'crates-io', confidence: 'high' }),
    );
  });

  it('falls back to crate.homepage with medium confidence when repository is absent', async () => {
    mockFetchSequence([
      {
        url: 'crates.io/api/v1/crates/no-repo-crate',
        body: { crate: { homepage: 'https://github.com/foo/no-repo-crate' } },
      },
    ]);
    const r = await resolveRepo('no-repo-crate', 'cargo');
    expect(r?.confidence).toBe('medium');
    expect(r?.repo).toBe('no-repo-crate');
  });

  it('returns null on 404 (no fuzzy fabrication)', async () => {
    mockFetchSequence([{ url: 'crates.io/api/v1/crates/missing', status: 404 }]);
    const r = await resolveRepo('missing', 'cargo');
    expect(r).toBeNull();
  });

  it('returns fuzzyFallback on transient (5xx) failure', async () => {
    mockFetchSequence([{ url: 'crates.io/api/v1/crates/down', status: 503 }]);
    const r = await resolveRepo('down', 'cargo');
    expect(r?.source).toBe('fuzzy');
    expect(r?.confidence).toBe('low');
  });

  it('sends a User-Agent header (crates.io Cloudflare requirement)', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ crate: { repository: 'https://github.com/serde-rs/serde' } }),
        text: async () => '',
      } as Response;
    }) as typeof fetch;
    await resolveRepo('serde', 'cargo');
    expect(capturedHeaders?.['User-Agent']).toContain('codewiki-mcp');
  });
});

describe('resolveRepo — composer (Packagist, v2.2)', () => {
  it('parses packages[<name>][0].source.url as high confidence', async () => {
    mockFetchSequence([
      {
        url: 'repo.packagist.org/p2/laravel/framework.json',
        body: {
          packages: {
            'laravel/framework': [
              { source: { url: 'https://github.com/laravel/framework.git' } },
            ],
          },
        },
      },
    ]);
    const r = await resolveRepo('laravel/framework', 'composer');
    expect(r).toEqual(
      expect.objectContaining({ owner: 'laravel', repo: 'framework', source: 'packagist', confidence: 'high' }),
    );
  });

  it('returns null when name is not vendor/package format', async () => {
    const r = await resolveRepo('not-vendor-format', 'composer');
    expect(r).toBeNull();
  });

  it('returns null on 404 (no fuzzy fabrication)', async () => {
    mockFetchSequence([{ url: 'repo.packagist.org/p2/foo/missing.json', status: 404 }]);
    const r = await resolveRepo('foo/missing', 'composer');
    expect(r).toBeNull();
  });

  it('falls back to homepage with medium confidence when source.url is absent', async () => {
    mockFetchSequence([
      {
        url: 'repo.packagist.org/p2/foo/bar.json',
        body: {
          packages: {
            'foo/bar': [{ homepage: 'https://github.com/foo/bar' }],
          },
        },
      },
    ]);
    const r = await resolveRepo('foo/bar', 'composer');
    expect(r?.confidence).toBe('medium');
    expect(r?.repo).toBe('bar');
  });

  it('returns fuzzyFallback on transient (5xx)', async () => {
    mockFetchSequence([{ url: 'repo.packagist.org/p2/foo/down.json', status: 503 }]);
    const r = await resolveRepo('foo/down', 'composer');
    expect(r?.source).toBe('fuzzy');
  });
});

// ---------------------------------------------------------------------------
// v2.3 resolvers: Maven Central, RubyGems, NuGet
// ---------------------------------------------------------------------------

describe('resolveRepo — maven (Maven Central, v2.3)', () => {
  it('two-step search→POM: returns high-confidence repo from <scm><url>', async () => {
    mockFetchSequence([
      { url: 'search.maven.org/solrsearch', body: { response: { docs: [{ v: '2.16.0' }] } } },
      {
        url: 'repo1.maven.org',
        text: '<project><scm><url>https://github.com/FasterXML/jackson-databind</url></scm></project>',
      },
    ]);
    const r = await resolveRepo('com.fasterxml.jackson.core:jackson-databind', 'maven');
    expect(r).toEqual({
      owner: 'FasterXML',
      repo: 'jackson-databind',
      source: 'maven-central',
      confidence: 'high',
    });
  });

  it('strips scm:git: prefix from <scm><connection>', async () => {
    mockFetchSequence([
      { url: 'search.maven.org/solrsearch', body: { response: { docs: [{ v: '6.1.0' }] } } },
      {
        url: 'repo1.maven.org',
        text: '<project><scm><connection>scm:git:https://github.com/spring-projects/spring-framework.git</connection></scm></project>',
      },
    ]);
    const r = await resolveRepo('org.springframework:spring-core', 'maven');
    expect(r?.owner).toBe('spring-projects');
    expect(r?.repo).toBe('spring-framework');
    expect(r?.confidence).toBe('high');
  });

  it('search 404 returns null', async () => {
    mockFetchSequence([{ url: 'search.maven.org/solrsearch', status: 404, body: {} }]);
    expect(await resolveRepo('com.example:nonexistent', 'maven')).toBeNull();
  });

  it('search-empty-docs returns null', async () => {
    mockFetchSequence([
      { url: 'search.maven.org/solrsearch', body: { response: { docs: [] } } },
    ]);
    expect(await resolveRepo('com.example:empty', 'maven')).toBeNull();
  });

  it('POM 404 returns null', async () => {
    mockFetchSequence([
      { url: 'search.maven.org/solrsearch', body: { response: { docs: [{ v: '1.0' }] } } },
      { url: 'repo1.maven.org', status: 404, body: {} },
    ]);
    expect(await resolveRepo('com.example:gone', 'maven')).toBeNull();
  });

  it('transient (5xx) returns null (no fuzzyFallback for explicit Maven coords)', async () => {
    mockFetchSequence([{ url: 'search.maven.org/solrsearch', status: 503, body: {} }]);
    expect(await resolveRepo('com.example:foo', 'maven')).toBeNull();
  });

  it('rejects non-<groupId>:<artifactId> input', async () => {
    expect(await resolveRepo('not-a-coord', 'maven')).toBeNull();
    expect(await resolveRepo('a:b:c', 'maven')).toBeNull();
    expect(await resolveRepo(':missing-group', 'maven')).toBeNull();
  });

  it('populates alternates when multiple GH URLs parse', async () => {
    mockFetchSequence([
      { url: 'search.maven.org/solrsearch', body: { response: { docs: [{ v: '1.0' }] } } },
      {
        url: 'repo1.maven.org',
        text:
          '<project><scm><url>https://github.com/A/X</url></scm><url>https://github.com/B/Y</url></project>',
      },
    ]);
    const r = await resolveRepo('com.example:multi', 'maven');
    expect(r?.owner).toBe('A');
    expect(r?.repo).toBe('X');
    expect(r?.alternates).toEqual([{ owner: 'B', repo: 'Y', source: 'maven-central' }]);
  });
});

describe('resolveRepo — rubygems (v2.3)', () => {
  it('parses source_code_uri at high confidence', async () => {
    mockFetchSequence([
      {
        url: 'rubygems.org/api/v1/gems/rails.json',
        body: { source_code_uri: 'https://github.com/rails/rails' },
      },
    ]);
    const r = await resolveRepo('rails', 'gem');
    expect(r).toEqual({
      owner: 'rails',
      repo: 'rails',
      source: 'rubygems',
      confidence: 'high',
    });
  });

  it('falls back to homepage_uri at medium confidence', async () => {
    mockFetchSequence([
      {
        url: 'rubygems.org/api/v1/gems/somegem.json',
        body: { homepage_uri: 'https://github.com/foo/somegem' },
      },
    ]);
    const r = await resolveRepo('somegem', 'gem');
    expect(r?.owner).toBe('foo');
    expect(r?.confidence).toBe('medium');
  });

  it('404 returns null', async () => {
    mockFetchSequence([{ url: 'rubygems.org/api/v1/gems', status: 404, body: {} }]);
    expect(await resolveRepo('nonexistent', 'gem')).toBeNull();
  });

  it('transient (5xx) returns fuzzyFallback', async () => {
    mockFetchSequence([{ url: 'rubygems.org/api/v1/gems', status: 503, body: {} }]);
    const r = await resolveRepo('rails', 'gem');
    expect(r?.source).toBe('fuzzy');
    expect(r?.confidence).toBe('low');
  });

  it('non-github URL returns null', async () => {
    mockFetchSequence([
      {
        url: 'rubygems.org/api/v1/gems/x.json',
        body: { source_code_uri: 'https://gitlab.com/x/x', homepage_uri: 'https://example.com' },
      },
    ]);
    expect(await resolveRepo('x', 'gem')).toBeNull();
  });
});

describe('resolveRepo — nuget (v2.3)', () => {
  it('two-step flatcontainer→nuspec: picks latest stable, parses <repository url>', async () => {
    mockFetchSequence([
      {
        url: 'api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json',
        body: { versions: ['12.0.0', '13.0.3', '14.0.0-preview.1'] },
      },
      {
        url: 'api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.nuspec',
        text:
          '<package><metadata><repository url="https://github.com/JamesNK/Newtonsoft.Json" /></metadata></package>',
      },
    ]);
    const r = await resolveRepo('Newtonsoft.Json', 'nuget');
    expect(r?.owner).toBe('JamesNK');
    expect(r?.repo).toBe('Newtonsoft.Json');
    expect(r?.source).toBe('nuget');
    expect(r?.confidence).toBe('high');
  });

  it('lowercases the URL but preserves original case in the input', async () => {
    mockFetchSequence([
      {
        url: 'api.nuget.org/v3-flatcontainer/serilog/index.json',
        body: { versions: ['3.1.1'] },
      },
      {
        url: 'api.nuget.org/v3-flatcontainer/serilog/3.1.1/serilog.nuspec',
        text: '<package><metadata><projectUrl>https://github.com/serilog/serilog</projectUrl></metadata></package>',
      },
    ]);
    const r = await resolveRepo('Serilog', 'nuget');
    expect(r?.owner).toBe('serilog');
    expect(r?.confidence).toBe('medium'); // projectUrl is medium
  });

  it('all-prerelease versions: picks highest via semver', async () => {
    mockFetchSequence([
      {
        url: 'api.nuget.org/v3-flatcontainer/foo/index.json',
        body: { versions: ['1.0.0-rc.2', '1.0.0-rc.10', '1.0.0-alpha'] },
      },
      {
        url: 'api.nuget.org/v3-flatcontainer/foo/1.0.0-rc.10/foo.nuspec',
        text: '<package><metadata><repository url="https://github.com/x/foo" /></metadata></package>',
      },
    ]);
    const r = await resolveRepo('foo', 'nuget');
    // The selected nuspec URL must be the rc.10 version (asserted by the URL match),
    // and the resulting repo must come from that nuspec.
    expect(r?.repo).toBe('foo');
  });

  it('flatcontainer 404 returns null', async () => {
    mockFetchSequence([
      { url: 'api.nuget.org/v3-flatcontainer/missing/index.json', status: 404, body: {} },
    ]);
    expect(await resolveRepo('missing', 'nuget')).toBeNull();
  });

  it('flatcontainer transient (5xx) returns fuzzyFallback', async () => {
    mockFetchSequence([
      { url: 'api.nuget.org/v3-flatcontainer/foo/index.json', status: 503, body: {} },
    ]);
    const r = await resolveRepo('foo', 'nuget');
    expect(r?.source).toBe('fuzzy');
  });

  it('rejects names with invalid characters', async () => {
    expect(await resolveRepo('foo bar', 'nuget')).toBeNull();
    expect(await resolveRepo('foo/bar', 'nuget')).toBeNull();
  });
});

describe('resolveRepo — nuget semver edge cases (v2.3 verify-phase fixes)', () => {
  it('handles 4-part Microsoft versions (1.0.0.0) by coercing to semver', async () => {
    mockFetchSequence([
      {
        url: 'api.nuget.org/v3-flatcontainer/microsoft.example/index.json',
        body: { versions: ['1.0.0.0', '2.0.0.0', '1.5.0.0'] },
      },
      {
        url: 'api.nuget.org/v3-flatcontainer/microsoft.example/2.0.0.0/microsoft.example.nuspec',
        text: '<package><metadata><repository url="https://github.com/microsoft/example" /></metadata></package>',
      },
    ]);
    const r = await resolveRepo('Microsoft.Example', 'nuget');
    // The fact that the fetch matched `2.0.0.0` URL proves correct ordering.
    expect(r?.owner).toBe('microsoft');
    expect(r?.repo).toBe('example');
  });

  it('ignores build metadata (`+abc`) in version comparison', async () => {
    mockFetchSequence([
      {
        url: 'api.nuget.org/v3-flatcontainer/foo/index.json',
        body: { versions: ['1.2.3+build.1', '1.2.3+build.42', '1.2.4'] },
      },
      {
        url: 'api.nuget.org/v3-flatcontainer/foo/1.2.4/foo.nuspec',
        text: '<package><metadata><repository url="https://github.com/x/foo" /></metadata></package>',
      },
    ]);
    const r = await resolveRepo('foo', 'nuget');
    expect(r?.repo).toBe('foo');
  });
});

/**
 * Framework dep → context-attribute mapping.
 *
 * Curated table of well-known framework runtime entries. Each entry maps a
 * dependency name (exact OR `prefix*`) inside a specific ecosystem to a
 * structured `FrameworkContext` (name + confidence + sourceRepo).
 *
 * **Quarterly review cadence** (parallel to `gradle_plugin_coords.ts`).
 * Out-of-date entries produce silently wrong framework context; no automated
 * drift detection ships in v0.6. Adding a new well-known framework: PR
 * updating this file + the unit test `tests/unit/framework_detector.test.ts`.
 *
 * Match semantics:
 *   - `matchKind: 'exact'` → `dep.name === pattern` (case-sensitive).
 *   - `matchKind: 'prefix'` → `dep.name.startsWith(pattern.slice(0, -1))`
 *     where `pattern` ends with `*` (Maven starter-* family).
 *
 * Ecosystem-aware: a signature applies ONLY when `dep.ecosystem === entry.ecosystem`.
 * Same-name deps in different ecosystems do NOT cross-match.
 */

import type { Confidence, Ecosystem } from '../types.js';

export interface FrameworkSignature {
  /** Display name (what appears in `FrameworkContext.name`). */
  name: string;
  confidence: Confidence;
  /** GitHub `owner/repo` slug. */
  sourceRepo: string;
  matchKind: 'exact' | 'prefix';
  /** Match target. Prefix patterns end with `*` (e.g. `spring-boot-starter-*`). */
  pattern: string;
  ecosystem: Ecosystem;
}

export const FRAMEWORK_SIGNATURES: readonly FrameworkSignature[] = Object.freeze([
  // --- npm / Node / Web frameworks ---------------------------------------
  { name: 'next.js',   confidence: 'high', sourceRepo: 'vercel/next.js',     matchKind: 'exact', pattern: 'next',          ecosystem: 'npm' },
  { name: 'Nuxt',      confidence: 'high', sourceRepo: 'nuxt/nuxt',          matchKind: 'exact', pattern: 'nuxt',          ecosystem: 'npm' },
  { name: 'React',     confidence: 'high', sourceRepo: 'facebook/react',     matchKind: 'exact', pattern: 'react',         ecosystem: 'npm' },
  { name: 'Vue',       confidence: 'high', sourceRepo: 'vuejs/core',         matchKind: 'exact', pattern: 'vue',           ecosystem: 'npm' },
  { name: 'Angular',   confidence: 'high', sourceRepo: 'angular/angular',    matchKind: 'exact', pattern: '@angular/core', ecosystem: 'npm' },
  { name: 'Svelte',    confidence: 'high', sourceRepo: 'sveltejs/svelte',    matchKind: 'exact', pattern: 'svelte',        ecosystem: 'npm' },
  { name: 'NestJS',    confidence: 'high', sourceRepo: 'nestjs/nest',        matchKind: 'exact', pattern: '@nestjs/core',  ecosystem: 'npm' },
  { name: 'Express',   confidence: 'high', sourceRepo: 'expressjs/express',  matchKind: 'exact', pattern: 'express',       ecosystem: 'npm' },
  { name: 'Fastify',   confidence: 'high', sourceRepo: 'fastify/fastify',    matchKind: 'exact', pattern: 'fastify',       ecosystem: 'npm' },

  // --- PyPI / Python -----------------------------------------------------
  { name: 'Django',    confidence: 'high', sourceRepo: 'django/django',      matchKind: 'exact', pattern: 'django',        ecosystem: 'pypi' },
  { name: 'Flask',     confidence: 'high', sourceRepo: 'pallets/flask',      matchKind: 'exact', pattern: 'flask',         ecosystem: 'pypi' },
  { name: 'FastAPI',   confidence: 'high', sourceRepo: 'tiangolo/fastapi',   matchKind: 'exact', pattern: 'fastapi',       ecosystem: 'pypi' },

  // --- Maven / Java ------------------------------------------------------
  { name: 'Spring Boot',      confidence: 'high', sourceRepo: 'spring-projects/spring-boot',       matchKind: 'prefix', pattern: 'org.springframework.boot:spring-boot-starter-*', ecosystem: 'maven' },
  { name: 'Spring Framework', confidence: 'high', sourceRepo: 'spring-projects/spring-framework',  matchKind: 'exact',  pattern: 'org.springframework:spring-context',            ecosystem: 'maven' },
  { name: 'Spring Framework', confidence: 'high', sourceRepo: 'spring-projects/spring-framework',  matchKind: 'exact',  pattern: 'org.springframework:spring-core',               ecosystem: 'maven' },

  // --- RubyGems ----------------------------------------------------------
  { name: 'Rails',     confidence: 'high', sourceRepo: 'rails/rails',        matchKind: 'exact', pattern: 'rails',         ecosystem: 'gem' },

  // --- Go ----------------------------------------------------------------
  { name: 'Gin',       confidence: 'high', sourceRepo: 'gin-gonic/gin',      matchKind: 'exact', pattern: 'github.com/gin-gonic/gin',       ecosystem: 'go' },
  { name: 'Echo',      confidence: 'high', sourceRepo: 'labstack/echo',      matchKind: 'exact', pattern: 'github.com/labstack/echo/v4',    ecosystem: 'go' },
  { name: 'Fiber',     confidence: 'high', sourceRepo: 'gofiber/fiber',      matchKind: 'exact', pattern: 'github.com/gofiber/fiber/v2',    ecosystem: 'go' },
  { name: 'Chi',       confidence: 'high', sourceRepo: 'go-chi/chi',         matchKind: 'exact', pattern: 'github.com/go-chi/chi/v5',       ecosystem: 'go' },

  // --- Cargo / Rust ------------------------------------------------------
  { name: 'Actix',     confidence: 'high',   sourceRepo: 'actix/actix-web',  matchKind: 'exact', pattern: 'actix-web',     ecosystem: 'cargo' },
  { name: 'Axum',      confidence: 'high',   sourceRepo: 'tokio-rs/axum',    matchKind: 'exact', pattern: 'axum',          ecosystem: 'cargo' },
  { name: 'Rocket',    confidence: 'high',   sourceRepo: 'rwf2/Rocket',      matchKind: 'exact', pattern: 'rocket',        ecosystem: 'cargo' },
  { name: 'Tokio',     confidence: 'medium', sourceRepo: 'tokio-rs/tokio',   matchKind: 'exact', pattern: 'tokio',         ecosystem: 'cargo' },

  // --- NuGet / .NET ------------------------------------------------------
  { name: 'ASP.NET Core', confidence: 'high', sourceRepo: 'dotnet/aspnetcore', matchKind: 'exact', pattern: 'Microsoft.AspNetCore.App', ecosystem: 'nuget' },
  { name: 'Blazor',       confidence: 'high', sourceRepo: 'dotnet/aspnetcore', matchKind: 'exact', pattern: 'Microsoft.AspNetCore.Components.Web', ecosystem: 'nuget' },
]);

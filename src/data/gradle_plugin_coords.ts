/**
 * Gradle plugin id → Maven coordinate mapping.
 *
 * Hardcoded table for the top-N well-known Gradle plugins. Curated from
 * each plugin's documentation / `META-INF/gradle-plugins/<id>.properties`.
 *
 * **Quarterly review cadence (v2.5 plan §Risks).** Out-of-date mappings
 * produce wrong dep entries silently — no automated drift detection ships
 * in v2.5 (the optional `tests/integration/gradle_plugin_coords_drift.integration.test.ts`
 * is gated behind `CODEWIKI_DRIFT_CHECK=1`). Mapping issues: open a PR
 * updating this file. Adding a NEW well-known plugin: same.
 *
 * v2.5 explicitly does NOT call `https://plugins.gradle.org/api/v1/plugins/<id>`
 * for unmapped plugins (zero-new-network-call boundary; deferred to v2.6).
 * Unmapped plugins emit a one-time `gradle_plugin_unmapped` warn at scan
 * time and are skipped.
 */

export interface GradlePluginCoord {
  groupId: string;
  artifactId: string;
}

export const GRADLE_PLUGIN_COORDS: Readonly<Record<string, GradlePluginCoord>> = Object.freeze({
  // --- Kotlin (JetBrains) -----------------------------------------------
  'org.jetbrains.kotlin.jvm': { groupId: 'org.jetbrains.kotlin', artifactId: 'kotlin-gradle-plugin' },
  'org.jetbrains.kotlin.android': { groupId: 'org.jetbrains.kotlin', artifactId: 'kotlin-gradle-plugin' },
  'org.jetbrains.kotlin.multiplatform': { groupId: 'org.jetbrains.kotlin', artifactId: 'kotlin-gradle-plugin' },
  'org.jetbrains.kotlin.kapt': { groupId: 'org.jetbrains.kotlin', artifactId: 'kotlin-gradle-plugin' },
  'org.jetbrains.kotlin.plugin.serialization': { groupId: 'org.jetbrains.kotlin', artifactId: 'kotlin-serialization' },
  'org.jetbrains.kotlin.plugin.spring': { groupId: 'org.jetbrains.kotlin', artifactId: 'kotlin-allopen' },
  'org.jetbrains.kotlin.plugin.jpa': { groupId: 'org.jetbrains.kotlin', artifactId: 'kotlin-noarg' },
  'org.jetbrains.kotlin.plugin.allopen': { groupId: 'org.jetbrains.kotlin', artifactId: 'kotlin-allopen' },
  'org.jetbrains.kotlin.plugin.noarg': { groupId: 'org.jetbrains.kotlin', artifactId: 'kotlin-noarg' },

  // --- Spring -----------------------------------------------------------
  'org.springframework.boot': { groupId: 'org.springframework.boot', artifactId: 'spring-boot-gradle-plugin' },
  'io.spring.dependency-management': { groupId: 'io.spring.gradle', artifactId: 'dependency-management-plugin' },

  // --- Android Gradle Plugin --------------------------------------------
  'com.android.application': { groupId: 'com.android.tools.build', artifactId: 'gradle' },
  'com.android.library': { groupId: 'com.android.tools.build', artifactId: 'gradle' },
  'com.android.test': { groupId: 'com.android.tools.build', artifactId: 'gradle' },
  'com.android.dynamic-feature': { groupId: 'com.android.tools.build', artifactId: 'gradle' },

  // --- Code quality / formatting ---------------------------------------
  'com.diffplug.spotless': { groupId: 'com.diffplug.spotless', artifactId: 'spotless-plugin-gradle' },
  'org.sonarqube': { groupId: 'org.sonarsource.scanner.gradle', artifactId: 'sonarqube-gradle-plugin' },
  'checkstyle': { groupId: 'com.puppycrawl.tools', artifactId: 'checkstyle' },
  'pmd': { groupId: 'net.sourceforge.pmd', artifactId: 'pmd' },
  'jacoco': { groupId: 'org.jacoco', artifactId: 'org.jacoco.core' },

  // --- Dependency / version management ----------------------------------
  'com.github.ben-manes.versions': { groupId: 'com.github.ben-manes', artifactId: 'gradle-versions-plugin' },
  'org.flywaydb.flyway': { groupId: 'org.flywaydb', artifactId: 'flyway-gradle-plugin' },

  // --- Documentation ----------------------------------------------------
  'org.jetbrains.dokka': { groupId: 'org.jetbrains.dokka', artifactId: 'dokka-gradle-plugin' },

  // --- Publishing -------------------------------------------------------
  'maven-publish': { groupId: 'org.gradle', artifactId: 'maven-publish' },
  'com.gradle.plugin-publish': { groupId: 'com.gradle.publish', artifactId: 'plugin-publish-plugin' },
  'io.github.gradle-nexus.publish-plugin': { groupId: 'io.github.gradle-nexus', artifactId: 'publish-plugin' },

  // --- Shadowing / fat-jar ----------------------------------------------
  'com.github.johnrengelman.shadow': { groupId: 'com.github.johnrengelman.shadow', artifactId: 'gradle-plugin' },
  'io.github.goooler.shadow': { groupId: 'io.github.goooler.shadow', artifactId: 'gradle-plugin' },

  // --- Misc popular ----------------------------------------------------
  'com.gorylenko.gradle-git-properties': { groupId: 'com.gorylenko.gradle-git-properties', artifactId: 'gradle-git-properties' },
  'org.openapi.generator': { groupId: 'org.openapitools', artifactId: 'openapi-generator-gradle-plugin' },
  'com.google.protobuf': { groupId: 'com.google.protobuf', artifactId: 'protobuf-gradle-plugin' },
  'idea': { groupId: 'org.gradle', artifactId: 'idea' },
  'eclipse': { groupId: 'org.gradle', artifactId: 'eclipse' },

  // Built-in Gradle plugins like 'java', 'java-library', 'application',
  // 'groovy', 'scala' are intentionally NOT mapped — they have no
  // groupId:artifactId on Maven Central (they ship with Gradle itself).
  // Unmapped → silent skip via the warn-once handler.
});

/**
 * Resolve a plugin id to its Maven coordinate. Returns null when unmapped
 * — caller should warn-log once-per-id-per-scan and skip.
 */
export function resolveGradlePluginCoord(pluginId: string): GradlePluginCoord | null {
  return GRADLE_PLUGIN_COORDS[pluginId] ?? null;
}

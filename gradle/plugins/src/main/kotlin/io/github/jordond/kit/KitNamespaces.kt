package io.github.jordond.kit

import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import java.util.concurrent.ConcurrentHashMap

/**
 * Default Android namespaces kit derives, unique per build. A module's namespace comes from its full
 * path (`:core:api:model` -> `<app-name>.core.api.model`) so nested modules with the same name
 * (`:core:ui`, `:feature:forecast:ui`) don't collide; two paths mapping to the same namespace
 * (`:core-ui` and `:core:ui`) fail the build naming both.
 */
internal object KitNamespaces {
    fun forPath(
        appName: String,
        path: String,
    ): String {
        val segments =
            path
                .split(':')
                .filter { it.isNotEmpty() }
                .flatMap { it.split('-', '.') }
                .map { segment -> segment.lowercase().replace(Regex("[^a-z0-9_]"), "_") }
                .map { if (it.first().isDigit()) "_$it" else it }
        return (listOf(appName) + segments).joinToString(".")
    }

    fun claim(
        project: Project,
        namespace: String,
        plugin: String,
    ) {
        val registry =
            project.gradle.sharedServices
                .registerIfAbsent("kitNamespaces", Registry::class.java) {}
                .get()
        val owner = registry.claims.putIfAbsent(namespace, project.path)
        if (owner != null && owner != project.path) {
            throw GradleException(
                "kit.$plugin: $owner and ${project.path} both get the Android namespace '$namespace'; " +
                    "set `namespace` in one of them",
            )
        }
    }

    abstract class Registry : BuildService<BuildServiceParameters.None> {
        val claims = ConcurrentHashMap<String, String>()
    }
}

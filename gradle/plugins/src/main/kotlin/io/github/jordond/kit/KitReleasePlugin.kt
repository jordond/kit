package io.github.jordond.kit

import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.api.provider.Provider

/**
 * `io.github.jordond.kit.release`: the CLI <-> Gradle version contract for an Android app module.
 *
 * - versionName = -Pkit.versionName ?: catalog `app-android-version` ?: whatever the DSL set
 * - versionCode = -Pkit.versionCode ?: whatever the DSL set ?: 1
 *
 * Gradle properties are wired as Providers into the variant outputs, never read eagerly here,
 * so they stay lazy for the configuration cache.
 */
class KitReleasePlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.pluginManager.withPlugin("com.android.application") {
            configure(project)
        }
        project.afterEvaluate {
            if (!project.pluginManager.hasPlugin("com.android.application")) {
                throw GradleException("kit.release: apply com.android.application to ${project.path}")
            }
        }
    }

    private fun configure(project: Project) {
        val providers = project.providers

        val versionCodeProp: Provider<Int> =
            providers.gradleProperty("kit.versionCode").map { raw ->
                raw.trim().toIntOrNull()?.takeIf { it > 0 }
                    ?: throw GradleException("kit.release: -Pkit.versionCode must be a positive integer, got '$raw'")
            }
        val versionNameProp: Provider<String> = providers.gradleProperty("kit.versionName")

        val catalogVersionName: String? =
            project.extensions.findByType(VersionCatalogsExtension::class.java)
                ?.find("libs")?.orElse(null)
                ?.findVersion("app-android-version")?.orElse(null)
                ?.requiredVersion

        val components = project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
        components.onVariants { variant ->
            variant.outputs.forEach { output ->
                // Snapshot the DSL-derived values (no provider chain back into the same property).
                val dslCode: Int? = output.versionCode.orNull
                val dslName: String? = output.versionName.orNull

                output.versionCode.set(versionCodeProp.orElse(providers.provider { dslCode ?: 1 }))
                val fallbackName = catalogVersionName ?: dslName
                output.versionName.set(
                    if (fallbackName != null) versionNameProp.orElse(fallbackName) else versionNameProp,
                )
            }
        }
    }
}

package io.github.jordond.kit

import org.gradle.api.Action
import org.gradle.api.Plugin
import org.gradle.api.artifacts.dsl.RepositoryHandler
import org.gradle.api.initialization.Settings
import org.gradle.api.plugins.UnknownPluginException
import javax.inject.Inject

/**
 * `io.github.jordond.kit.settings`: shared settings conventions.
 *
 * - `TYPESAFE_PROJECT_ACCESSORS` (idempotent).
 * - The foojay toolchain resolver, when `org.gradle.toolchains.foojay-resolver-convention` is on the
 *   settings classpath (kit's POMs carry no dependencies, so the app's settings `plugins { }` brings it).
 * - Dependency repositories: Google (content-filtered to androidx, com.android, com.google) and Maven
 *   Central, each added only if the build hasn't declared one by that name.
 * - `kit { extraRepos { … } }` appends app-specific repositories (brewd's sentry-cocoa ivy repo).
 *
 * Lives in its own artifact (kit-settings) and never references AGP, KGP or Compose types: the settings
 * classloader can't see them (spike S7).
 */
class KitSettingsPlugin : Plugin<Settings> {
    override fun apply(settings: Settings) {
        settings.enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")
        applyFoojay(settings)
        settings.extensions.create("kit", KitSettingsExtension::class.java, settings)

        val repositories = settings.dependencyResolutionManagement.repositories
        if (repositories.findByName("Google") == null) {
            repositories.google {
                mavenContent {
                    includeGroupAndSubgroups("androidx")
                    includeGroupAndSubgroups("com.android")
                    includeGroupAndSubgroups("com.google")
                }
            }
        }
        if (repositories.findByName("MavenRepo") == null) repositories.mavenCentral()
    }

    private fun applyFoojay(settings: Settings) {
        if (settings.pluginManager.hasPlugin(FOOJAY)) return
        try {
            settings.pluginManager.apply(FOOJAY)
        } catch (_: UnknownPluginException) {
            // Not on the settings classpath; toolchains resolve from installed JDKs only.
        }
    }

    private companion object {
        const val FOOJAY = "org.gradle.toolchains.foojay-resolver-convention"
    }
}

/** The settings-level `kit { }` block. */
abstract class KitSettingsExtension
    @Inject
    constructor(
        private val settings: Settings,
    ) {
        /** Appends repositories to `dependencyResolutionManagement`, after kit's defaults. */
        fun extraRepos(action: Action<RepositoryHandler>) = action.execute(settings.dependencyResolutionManagement.repositories)
    }

package io.github.jordond.kit

import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.provider.Provider

/**
 * `io.github.jordond.kit.release`: the CLI <-> Gradle contract (PLAN §13.4).
 *
 * On `com.android.application`:
 * - versionName = -Pkit.versionName ?: catalog `app-android-version`
 * - versionCode = -Pkit.versionCode ?: 1
 * - release signing from -Pkit.keystoreFile or ANDROID_KEYSTORE_BASE64, plus ANDROID_KEYSTORE_ALIAS /
 *   _PASSWORD, resolved lazily (see ReleaseSigning.kt). Without one the release build fails, unless
 *   `kit { allowDebugFallback = true }`.
 *
 * On `org.jetbrains.kotlin.multiplatform`: generates `BuildConstants` into commonMain (BuildInfo.kt).
 *
 * Gradle properties are wired as Providers, never read at configuration time, so changing them
 * re-evaluates on a configuration-cache hit instead of reconfiguring.
 */
class KitReleasePlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val kit = project.kitExtension()
        project.requireOneOf(PLUGIN, PluginIds.ANDROID_APPLICATION, PluginIds.KOTLIN_MULTIPLATFORM)
        project.pluginManager.withPlugin(PluginIds.ANDROID_APPLICATION) {
            configureAndroid(project, kit)
        }
        project.pluginManager.withPlugin(PluginIds.KOTLIN_MULTIPLATFORM) {
            BuildInfo.register(project, kit)
        }
    }

    private fun configureAndroid(
        project: Project,
        kit: KitExtension,
    ) {
        val versionCode = KitVersions.versionCode(project)
        val versionName = KitVersions.versionName(project)
        val signing = ReleaseSigning(project, kit)

        val components = project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
        components.finalizeDsl { dsl -> signing.finalizeDsl(dsl) }
        components.onVariants { variant ->
            variant.outputs.forEach { output ->
                output.versionCode.set(versionCode)
                output.versionName.set(versionName)
            }
            if (variant.buildType == RELEASE) signing.wire(variant)
        }
    }

    internal companion object {
        const val PLUGIN = "release"
        const val RELEASE = "release"
    }
}

/** The version inputs shared by the Android outputs and BuildInfo. */
internal object KitVersions {
    fun versionCode(project: Project): Provider<Int> =
        project.providers.gradleProperty("kit.versionCode").map(::parseVersionCode).orElse(1)

    /** -Pkit.versionName ?: catalog `app-android-version` (required: checked at configuration time). */
    fun versionName(project: Project): Provider<String> {
        val catalog =
            KitCatalog(project, KitReleasePlugin.PLUGIN)
                .require(KitCatalog.ANDROID_VERSION, "versionName when -Pkit.versionName is absent")
        return project.providers.gradleProperty("kit.versionName").orElse(catalog)
    }

    fun parseVersionCode(raw: String): Int =
        raw.trim().toIntOrNull()?.takeIf { it > 0 }
            ?: throw GradleException("kit.release: -Pkit.versionCode must be a positive integer, got '$raw'")
}

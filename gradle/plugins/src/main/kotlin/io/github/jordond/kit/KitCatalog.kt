package io.github.jordond.kit

import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.artifacts.VersionCatalog
import org.gradle.api.artifacts.VersionCatalogsExtension

/**
 * The `libs` version catalog as kit reads it. Plugins built outside the app can't use type-safe
 * accessors, so the key names below are a contract (PLAN §13.5) that `kit doctor` also checks.
 */
internal class KitCatalog(
    private val project: Project,
    private val plugin: String,
) {
    private val libs: VersionCatalog? by lazy {
        project.extensions
            .findByType(VersionCatalogsExtension::class.java)
            ?.find("libs")
            ?.orElse(null)
    }

    fun version(key: String): String? =
        libs
            ?.findVersion(key)
            ?.orElse(null)
            ?.requiredVersion
            ?.takeIf { it.isNotBlank() }

    fun require(
        key: String,
        why: String,
    ): String =
        version(key) ?: throw GradleException(
            "kit.$plugin: version catalog 'libs' has no version '$key' ($why). " +
                "Add `$key = \"…\"` under [versions] in gradle/libs.versions.toml.",
        )

    fun requireInt(
        key: String,
        why: String,
    ): Int {
        val raw = require(key, why)
        return raw.toIntOrNull()
            ?: throw GradleException("kit.$plugin: catalog version '$key' must be an integer, got '$raw'")
    }

    companion object Keys {
        const val SDK_COMPILE = "app-android-sdk-compile"
        const val SDK_TARGET = "app-android-sdk-target"
        const val SDK_MIN = "app-android-sdk-min"
        const val JVM_TARGET = "app-jvm-target"
        const val ANDROID_VERSION = "app-android-version"
        const val IOS_VERSION = "app-ios-version"
        const val APP_NAME = "app-name"
    }
}

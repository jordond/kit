package io.github.jordond.kit

import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.plugins.UnknownPluginException

internal object PluginIds {
    const val ANDROID_APPLICATION = "com.android.application"
    const val ANDROID_TEST = "com.android.test"
    const val ANDROID_KMP_LIBRARY = "com.android.kotlin.multiplatform.library"
    const val KOTLIN_MULTIPLATFORM = "org.jetbrains.kotlin.multiplatform"
    const val KOTLIN_JVM = "org.jetbrains.kotlin.jvm"
    const val COMPOSE_COMPILER = "org.jetbrains.kotlin.plugin.compose"
    const val COMPOSE_MULTIPLATFORM = "org.jetbrains.compose"
    const val COMPOSE_HOT_RELOAD = "org.jetbrains.compose.hot-reload"
    const val SPOTLESS = "com.diffplug.spotless"
    const val BASELINE_PROFILE = "androidx.baselineprofile"
}

/**
 * Applies a third-party plugin by id. kit never bundles AGP, KGP, Compose or spotless, so the app's
 * root build must put them on the classpath (`alias(libs.plugins.x) apply false`); say so loudly.
 */
internal fun Project.applyRequired(
    id: String,
    kitPlugin: String,
) {
    if (pluginManager.hasPlugin(id)) return
    try {
        pluginManager.apply(id)
    } catch (e: Exception) {
        if (generateSequence<Throwable>(e) { it.cause }.none { it is UnknownPluginException }) throw e
        throw GradleException(
            "kit.$kitPlugin: plugin '$id' is not on the build classpath. " +
                "Declare it in the root build.gradle.kts: `plugins { alias(libs.plugins.…) apply false }` (id $id).",
            e,
        )
    }
}

/** Fails at the end of evaluation unless one of [ids] was applied to the project. */
internal fun Project.requireOneOf(
    kitPlugin: String,
    vararg ids: String,
) {
    afterEvaluate {
        if (ids.none { pluginManager.hasPlugin(it) }) {
            throw GradleException("kit.$kitPlugin: apply ${ids.joinToString(" or ")} to $path")
        }
    }
}

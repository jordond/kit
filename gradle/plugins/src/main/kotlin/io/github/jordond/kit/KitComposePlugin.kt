package io.github.jordond.kit

import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.jetbrains.kotlin.gradle.dsl.KotlinMultiplatformExtension

/**
 * `io.github.jordond.kit.compose`: Compose compiler + Compose Multiplatform on a KMP module, the common
 * Compose dependencies (runtime, foundation, ui, and components-resources unless
 * `kit { resources = false }`) at the Compose Multiplatform plugin's own version, and the shared
 * Compose opt-ins. `kit { hotReload = true }` applies org.jetbrains.compose.hot-reload.
 */
class KitComposePlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.applyRequired(PluginIds.COMPOSE_COMPILER, PLUGIN)
        project.applyRequired(PluginIds.COMPOSE_MULTIPLATFORM, PLUGIN)
        val kit = project.kitExtension()
        project.requireOneOf(PLUGIN, PluginIds.KOTLIN_MULTIPLATFORM)

        project.pluginManager.withPlugin(PluginIds.KOTLIN_MULTIPLATFORM) {
            val kotlin = project.extensions.getByType(KotlinMultiplatformExtension::class.java)
            val version = composeVersion()
            kotlin.compilerOptions { optIn.addAll(OPT_INS) }
            kotlin.sourceSets.named("commonMain").configure {
                dependencies {
                    COMMON.forEach { implementation("$it:$version") }
                }
            }
            project.afterEvaluate {
                if (kit.resources.get()) {
                    kotlin.sourceSets.getByName("commonMain").dependencies {
                        implementation("$RESOURCES:$version")
                    }
                }
            }
        }
    }

    private companion object {
        const val PLUGIN = "compose"

        val COMMON =
            listOf(
                "org.jetbrains.compose.runtime:runtime",
                "org.jetbrains.compose.foundation:foundation",
                "org.jetbrains.compose.ui:ui",
            )
        const val RESOURCES = "org.jetbrains.compose.components:components-resources"

        val OPT_INS =
            listOf(
                "androidx.compose.animation.ExperimentalAnimationApi",
                "androidx.compose.ui.ExperimentalComposeUiApi",
                "androidx.compose.animation.ExperimentalSharedTransitionApi",
                "androidx.compose.foundation.ExperimentalFoundationApi",
            )

        /**
         * The app's Compose Multiplatform version. Read reflectively: `composeVersion` is a compile-time
         * constant, so a direct reference would inline the version kit compiled against.
         */
        fun composeVersion(): String =
            try {
                Class
                    .forName("org.jetbrains.compose.ComposeBuildConfig", true, KitComposePlugin::class.java.classLoader)
                    .getField("composeVersion")
                    .get(null) as String
            } catch (e: ReflectiveOperationException) {
                throw GradleException("kit.$PLUGIN: could not read the Compose Multiplatform version", e)
            }
    }
}

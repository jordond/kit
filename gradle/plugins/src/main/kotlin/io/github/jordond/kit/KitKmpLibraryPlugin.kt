package io.github.jordond.kit

import org.gradle.api.Plugin
import org.gradle.api.Project
import org.jetbrains.kotlin.gradle.dsl.KotlinMultiplatformExtension
import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget

/**
 * `io.github.jordond.kit.kmp.library`: Kotlin Multiplatform with kit's shared conventions.
 *
 * Applies KMP, the default hierarchy, the shared opt-ins and `-Xexpect-actual-classes`, and
 * `-Xexport-kdoc` on native. Targets come from `kit { targets { android(); ios(); jvm(); js() } }`;
 * `android()` applies AGP 9's `com.android.kotlin.multiplatform.library` and fails loudly when it isn't
 * on the classpath. Namespace `<app-name>.<module>`, SDK levels and JVM target come from the catalog.
 */
class KitKmpLibraryPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.applyRequired(PluginIds.KOTLIN_MULTIPLATFORM, "kmp.library")
        val kit = project.kitExtension()
        val kotlin = project.extensions.getByType(KotlinMultiplatformExtension::class.java)

        kotlin.applyDefaultHierarchyTemplate()
        kotlin.compilerOptions {
            freeCompilerArgs.add("-Xexpect-actual-classes")
            optIn.addAll(SHARED_OPT_INS)
            optIn.addAll(kit.optIns)
        }

        // Native-only opt-ins go on native source sets so JVM/Android compilations don't warn about
        // unresolved markers.
        kotlin.sourceSets.configureEach {
            val sourceSet = this
            if (NATIVE_SOURCE_SET_PREFIXES.any { sourceSet.name.startsWith(it) }) {
                NATIVE_OPT_INS.forEach { sourceSet.languageSettings.optIn(it) }
            }
        }

        // https://kotlinlang.org/docs/native-objc-interop.html#export-of-kdoc-comments-to-generated-objective-c-headers
        kotlin.targets.withType(KotlinNativeTarget::class.java).configureEach {
            compilations.named("main").configure {
                compileTaskProvider.configure {
                    compilerOptions.freeCompilerArgs.add("-Xexport-kdoc")
                }
            }
        }
    }

    private companion object {
        val SHARED_OPT_INS =
            listOf(
                "kotlin.uuid.ExperimentalUuidApi",
                "kotlin.time.ExperimentalTime",
                "kotlinx.coroutines.ExperimentalCoroutinesApi",
                "kotlinx.coroutines.FlowPreview",
            )
        val NATIVE_OPT_INS =
            listOf(
                "kotlinx.cinterop.ExperimentalForeignApi",
                "kotlin.experimental.ExperimentalNativeApi",
            )
        val NATIVE_SOURCE_SET_PREFIXES = listOf("ios", "apple", "native", "macos")
    }
}

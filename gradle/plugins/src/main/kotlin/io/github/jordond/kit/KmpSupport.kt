package io.github.jordond.kit

import com.android.build.api.dsl.KotlinMultiplatformAndroidLibraryTarget
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.plugins.ExtensionAware
import org.jetbrains.kotlin.gradle.dsl.ExplicitApiMode
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinMultiplatformExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinProjectExtension
import org.jetbrains.kotlin.gradle.plugin.mpp.Framework
import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget

/** `kit { targets { … } }`. Each call declares the target immediately, so ordering is the script's. */
class KitTargets internal constructor(
    private val project: Project,
    private val ios: KitIosSpec,
) {
    /** Android via AGP 9's `com.android.kotlin.multiplatform.library` (never `com.android.library`). */
    fun android() = KmpSupport.android(project)

    /** iosArm64 + iosSimulatorArm64, each with a framework (static by default). */
    fun ios() = KmpSupport.ios(project, ios)

    fun jvm() = KmpSupport.jvm(project)

    /** JS for the browser. */
    fun js() = KmpSupport.js(project)
}

/** `kit { ios { frameworkName = "Shared"; isStatic = true } }`. */
class KitIosSpec internal constructor(
    private val project: Project,
) {
    /** Framework base name; defaults to the module name, capitalised (`:shared` -> `Shared`). */
    var frameworkName: String? = null

    var isStatic: Boolean = true

    internal fun resolvedName(): String = frameworkName ?: project.name.replaceFirstChar { it.uppercase() }

    internal fun apply() = KmpSupport.applyIos(project, this)
}

internal object KmpSupport {
    private const val PLUGIN = "kmp.library"

    private fun Project.kotlinMultiplatform(): KotlinMultiplatformExtension =
        extensions.findByType(KotlinMultiplatformExtension::class.java)
            ?: throw GradleException("kit.$PLUGIN: apply io.github.jordond.kit.kmp.library to $path before `kit { targets { } }`")

    fun explicitApi(
        project: Project,
        enabled: Boolean,
    ) {
        val kotlin =
            project.extensions.findByName("kotlin") as? KotlinProjectExtension
                ?: throw GradleException("kit: `explicitApi` needs a Kotlin plugin applied to ${project.path}")
        kotlin.explicitApi = if (enabled) ExplicitApiMode.Strict else ExplicitApiMode.Disabled
    }

    fun android(project: Project) {
        project.applyRequired(PluginIds.ANDROID_KMP_LIBRARY, PLUGIN)
        val kotlin = project.kotlinMultiplatform()
        val target =
            (kotlin as ExtensionAware).extensions.findByType(KotlinMultiplatformAndroidLibraryTarget::class.java)
                ?: throw GradleException(
                    "kit.$PLUGIN: ${PluginIds.ANDROID_KMP_LIBRARY} did not register the Kotlin android target on ${project.path}",
                )
        val catalog = KitCatalog(project, PLUGIN)
        if (target.namespace == null) {
            val app = catalog.require(KitCatalog.APP_NAME, "the Android namespace is <app-name>.<module>")
            target.namespace = "$app.${project.name.replace('-', '.')}"
        }
        target.compileSdk = catalog.requireInt(KitCatalog.SDK_COMPILE, "Android compileSdk")
        target.minSdk = catalog.requireInt(KitCatalog.SDK_MIN, "Android minSdk")
        target.compilerOptions.jvmTarget.set(jvmTarget(catalog))
    }

    fun jvm(project: Project) {
        val target = jvmTarget(KitCatalog(project, PLUGIN))
        project.kotlinMultiplatform().jvm {
            compilerOptions.jvmTarget.set(target)
        }
    }

    fun js(project: Project) {
        project.kotlinMultiplatform().js { browser() }
    }

    fun ios(
        project: Project,
        spec: KitIosSpec,
    ) {
        val kotlin = project.kotlinMultiplatform()
        listOf(kotlin.iosArm64(), kotlin.iosSimulatorArm64()).forEach { target ->
            if (target.binaries.withType(Framework::class.java).isEmpty()) {
                target.binaries.framework {
                    baseName = spec.resolvedName()
                    isStatic = spec.isStatic
                }
            }
        }
    }

    fun applyIos(
        project: Project,
        spec: KitIosSpec,
    ) {
        val kotlin = project.extensions.findByType(KotlinMultiplatformExtension::class.java) ?: return
        kotlin.targets.withType(KotlinNativeTarget::class.java).configureEach {
            binaries.withType(Framework::class.java).configureEach {
                baseName = spec.resolvedName()
                isStatic = spec.isStatic
            }
        }
    }

    private fun jvmTarget(catalog: KitCatalog): JvmTarget =
        JvmTarget.fromTarget(catalog.require(KitCatalog.JVM_TARGET, "JVM bytecode target"))
}

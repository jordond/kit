package io.github.jordond.kit

import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.plugins.JavaApplication
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.jvm.toolchain.JavaLanguageVersion

/**
 * `io.github.jordond.kit.jvm.app`: a Kotlin/JVM library or application (SIGO's server and CLI).
 *
 * Applies Kotlin JVM with a Java toolchain of `kit { jvmTarget }` ?: catalog `app-jvm-target` (KGP
 * derives the bytecode target from it). `kit { application("pkg.MainKt") }` applies `application`
 * with that main class.
 */
class KitJvmAppPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.applyRequired(PluginIds.KOTLIN_JVM, PLUGIN)
        val kit = project.kitExtension()
        val catalog = KitCatalog(project, PLUGIN)
        val fromCatalog = catalog.version(KitCatalog.JVM_TARGET)
        val target =
            kit.jvmTarget.orElse(
                project.providers.provider {
                    val raw = fromCatalog ?: throw GradleException(
                        "kit.$PLUGIN: set kit { jvmTarget = … } or add version '${KitCatalog.JVM_TARGET}' to the catalog",
                    )
                    raw.toIntOrNull() ?: throw GradleException("kit.$PLUGIN: catalog '${KitCatalog.JVM_TARGET}' must be an integer, got '$raw'")
                },
            )
        project.extensions
            .getByType(JavaPluginExtension::class.java)
            .toolchain
            .languageVersion
            .set(target.map(JavaLanguageVersion::of))
    }

    private companion object {
        const val PLUGIN = "jvm.app"
    }
}

internal object JvmAppSupport {
    fun application(
        project: Project,
        mainClass: String,
    ) {
        project.pluginManager.apply("application")
        project.extensions.getByType(JavaApplication::class.java).mainClass.set(mainClass)
    }
}

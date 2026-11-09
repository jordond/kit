package io.github.jordond.kit

import com.diffplug.gradle.spotless.SpotlessExtension
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import java.io.File

/**
 * `io.github.jordond.kit.lint`, applied once in the root build: spotless + ktlint for every project
 * (ported from brewd's and WhaleSay's root `subprojects { }` block).
 *
 * - kotlin: every .kt file under src, minus resources and build output
 * - kotlinGradle: the project's own .gradle.kts files
 * - xml: every .xml file under src
 *
 * ktlint reads the nearest `.editorconfig` at or above the Gradle root. Spotless itself comes from
 * the app's root `alias(libs.plugins.spotless)`. Options: `kit { ktlintVersion; excludes }`.
 */
class KitLintPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        if (project != project.rootProject) {
            throw GradleException("kit.lint: apply io.github.jordond.kit.lint once, in the root build.gradle.kts (not ${project.path})")
        }
        val kit = project.kitExtension()
        project.allprojects { applyRequired(PluginIds.SPOTLESS, PLUGIN) }

        // Read `kit { }` once the root script is done; subprojects are evaluated after that.
        project.afterEvaluate {
            val root = this
            val ktlint =
                kit.ktlintVersion.orNull
                    ?: KitCatalog(root, PLUGIN).version("ktlint")
                    ?: DEFAULT_KTLINT
            val editorConfig = findEditorConfig(root.rootDir)
            val excludes = kit.excludes.get()
            root.allprojects { configure(this, ktlint, editorConfig, excludes) }
        }
    }

    private fun configure(
        project: Project,
        ktlintVersion: String,
        editorConfig: File?,
        excludes: List<String>,
    ) {
        project.extensions.configure(SpotlessExtension::class.java) {
            kotlin {
                val step = ktlint(ktlintVersion)
                editorConfig?.let { step.setEditorConfigPath(it) }
                target(
                    project.fileTree(project.projectDir) {
                        include("src/**/*.kt")
                        exclude("src/**/resources/**/*.kt", "**/build/**")
                        exclude(excludes)
                    },
                )
            }
            kotlinGradle {
                val step = ktlint(ktlintVersion)
                editorConfig?.let { step.setEditorConfigPath(it) }
                target("*.gradle.kts")
                if (excludes.isNotEmpty()) targetExclude(excludes)
            }
            format("xml") {
                target("src/**/*.xml")
                targetExclude(listOf("**/build/**") + excludes)
            }
        }
    }

    private fun findEditorConfig(rootDir: File): File? =
        generateSequence(rootDir) { it.parentFile }
            .map { File(it, ".editorconfig") }
            .firstOrNull { it.isFile }

    private companion object {
        const val PLUGIN = "lint"
        const val DEFAULT_KTLINT = "1.8.0"
    }
}

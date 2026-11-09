package io.github.jordond.kit

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.ValueSource
import org.gradle.api.provider.ValueSourceParameters
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations
import org.jetbrains.kotlin.gradle.dsl.KotlinMultiplatformExtension
import java.io.ByteArrayOutputStream
import java.io.File
import javax.inject.Inject

/**
 * BuildInfo for a KMP module: `kitGenerateBuildInfo` writes `<package>.BuildConstants` into commonMain
 * (ported from brewd's GenerateBuildInfoTask; package and name configurable in `kit { buildInfo { } }`).
 *
 * - VERSION_NAME: Xcode's MARKETING_VERSION ?: -Pkit.versionName ?: catalog `app-android-version`
 * - VERSION_CODE: Xcode's CURRENT_PROJECT_VERSION ?: -Pkit.versionCode ?: 1
 * - IS_INTERNAL:  -Pkit.internal ?: env KIT_INTERNAL ("true"/"1") ?: false
 * - GIT_SHA:      `git rev-parse --short HEAD` ?: "unknown"
 *
 * Xcode exports its build settings to the script phase that runs embedAndSignAppleFrameworkForXcode,
 * so an iOS build carries the bundle's version; a Gradle-only build (Android, tests) carries kit's.
 * All of these are execution-time inputs, never configuration inputs.
 */
internal object BuildInfo {
    fun register(
        project: Project,
        kit: KitExtension,
    ) {
        val providers = project.providers
        val catalog = KitCatalog(project, KitReleasePlugin.PLUGIN)
        val appName = catalog.version(KitCatalog.APP_NAME)
        val xcodeVersionName = providers.environmentVariable("MARKETING_VERSION").filter { it.isNotBlank() }
        val xcodeVersionCode =
            providers.environmentVariable("CURRENT_PROJECT_VERSION").filter { it.isNotBlank() }.map { raw ->
                raw.trim().toIntOrNull()
                    ?: throw GradleException("kit.release: CURRENT_PROJECT_VERSION must be an integer, got '$raw'")
            }
        val internalFlag =
            providers
                .gradleProperty("kit.internal")
                .orElse(providers.environmentVariable("KIT_INTERNAL"))
                .map { it.trim().lowercase() == "true" || it.trim() == "1" }
                .orElse(false)
        val gitShaSource =
            providers.of(GitShaSource::class.java) {
                parameters.workingDir.set(project.layout.projectDirectory)
            }

        val task =
            project.tasks.register("kitGenerateBuildInfo", KitGenerateBuildInfoTask::class.java) {
                group = "kit"
                description = "Generates BuildConstants (version, build number, internal flag, git SHA) into commonMain."
                packageName.set(kit.buildInfo.packageName.orElse(providers.provider { appName?.let { "$it.core.platform" } }))
                className.set(kit.buildInfo.className)
                publicApi.set(kit.buildInfo.publicApi)
                versionName.set(xcodeVersionName.orElse(KitVersions.versionName(project)))
                versionCode.set(xcodeVersionCode.orElse(KitVersions.versionCode(project)))
                internalBuild.set(internalFlag)
                gitSha.set(gitShaSource)
                outputDir.set(project.layout.buildDirectory.dir("generated/kit/buildinfo/commonMain/kotlin"))
            }

        project.extensions
            .getByType(KotlinMultiplatformExtension::class.java)
            .sourceSets
            .named("commonMain")
            .configure { kotlin.srcDir(task.flatMap(KitGenerateBuildInfoTask::outputDir)) }
    }
}

@CacheableTask
abstract class KitGenerateBuildInfoTask : DefaultTask() {
    @get:Input
    @get:Optional
    abstract val packageName: Property<String>

    @get:Input
    abstract val className: Property<String>

    @get:Input
    abstract val publicApi: Property<Boolean>

    @get:Input
    abstract val versionName: Property<String>

    @get:Input
    abstract val versionCode: Property<Int>

    @get:Input
    abstract val internalBuild: Property<Boolean>

    @get:Input
    abstract val gitSha: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val pkg =
            packageName.orNull ?: throw GradleException(
                "kit.release: no BuildConstants package; set kit { buildInfo { packageName = \"…\" } } " +
                    "or add version '${KitCatalog.APP_NAME}' to the catalog",
            )
        val visibility = if (publicApi.get()) "public" else "internal"
        val root = outputDir.get().asFile
        root.deleteRecursively()
        val file = File(root, pkg.replace('.', '/')).resolve("${className.get()}.kt")
        file.parentFile.mkdirs()
        file.writeText(
            """
            |// Generated by io.github.jordond.kit.release. Do not edit.
            |package $pkg
            |
            |$visibility object ${className.get()} {
            |    $visibility const val VERSION_NAME: String = ${versionName.get().quoted()}
            |    $visibility const val VERSION_CODE: Int = ${versionCode.get()}
            |    $visibility const val IS_INTERNAL: Boolean = ${internalBuild.get()}
            |    $visibility const val GIT_SHA: String = ${gitSha.get().quoted()}
            |}
            |
            """.trimMargin(),
        )
    }

    private fun String.quoted(): String =
        "\"" + replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\${'$'}") + "\""
}

/** `git rev-parse --short HEAD`, or "unknown" outside a repository or without git. */
internal abstract class GitShaSource : ValueSource<String, GitShaSource.Params> {
    interface Params : ValueSourceParameters {
        val workingDir: DirectoryProperty
    }

    @get:Inject
    abstract val exec: ExecOperations

    override fun obtain(): String {
        val out = ByteArrayOutputStream()
        return try {
            val result =
                exec.exec {
                    commandLine("git", "rev-parse", "--short", "HEAD")
                    workingDir = parameters.workingDir.get().asFile
                    standardOutput = out
                    errorOutput = ByteArrayOutputStream()
                    isIgnoreExitValue = true
                }
            if (result.exitValue == 0) out.toString().trim().ifEmpty { UNKNOWN } else UNKNOWN
        } catch (_: Exception) {
            UNKNOWN
        }
    }

    private companion object {
        const val UNKNOWN = "unknown"
    }
}

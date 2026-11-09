package io.github.jordond.kit

import org.gradle.testkit.runner.BuildResult
import org.gradle.testkit.runner.GradleRunner
import java.io.File

/**
 * One matrix cell: the lowest and highest AGP / Kotlin / Compose (and Gradle) versions the apps use.
 * `gradle = null` runs on the Gradle that runs the tests (kit's wrapper).
 */
data class KitMatrixCell(
    val name: String,
    val agp: String,
    val kotlin: String,
    val compose: String,
    val gradle: String?,
) {
    override fun toString() = "$name (AGP $agp, Kotlin $kotlin, Compose $compose, Gradle ${gradle ?: "wrapper"})"

    companion object {
        val MIN = KitMatrixCell("min", agp = "9.2.1", kotlin = "2.4.0", compose = "1.11.1", gradle = "9.6.1")
        val MAX = KitMatrixCell("max", agp = "9.4.1", kotlin = "2.4.21", compose = "1.12.2", gradle = null)

        /** -Pkit.matrix=min|max|all (comma-separated). */
        fun selected(): List<KitMatrixCell> {
            val raw = System.getProperty("kit.matrix", "all")
            if (raw == "all") return listOf(MIN, MAX)
            val names = raw.split(',').map { it.trim() }.toSet()
            return listOf(MIN, MAX).filter { it.name in names }
        }
    }
}

/** A KMP library (`:shared`) + Android app (`:android`) resolving kit from the test file repo. */
class Fixture(
    val dir: File,
    private val cell: KitMatrixCell,
) {
    private val kitVersion = System.getProperty("kit.version") ?: error("kit.version not set")
    private val testRepo = System.getProperty("kit.testRepo") ?: error("kit.testRepo not set")
    private val testKitDir = File(System.getProperty("kit.testKitDir") ?: error("kit.testKitDir not set"))

    fun file(path: String): File = File(dir, path)

    fun write(
        path: String,
        content: String,
    ) {
        file(path).apply {
            parentFile.mkdirs()
            writeText(content.trimIndent() + "\n")
        }
    }

    fun runner(
        vararg args: String,
        env: Map<String, String> = emptyMap(),
    ): GradleRunner {
        val base = System.getenv().filterKeys { !it.startsWith("ANDROID_KEYSTORE_") && it != "KIT_INTERNAL" }
        return GradleRunner
            .create()
            .withProjectDir(dir)
            .withTestKitDir(testKitDir)
            .withEnvironment(base + env)
            .withArguments(args.toList() + listOf("--configuration-cache", "--stacktrace"))
            .forwardOutput()
            .also { runner -> cell.gradle?.let { runner.withGradleVersion(it) } }
    }

    fun build(
        vararg args: String,
        env: Map<String, String> = emptyMap(),
    ): BuildResult = runner(*args, env = env).build()

    fun fail(
        vararg args: String,
        env: Map<String, String> = emptyMap(),
    ): BuildResult = runner(*args, env = env).buildAndFail()

    fun create(withB3: Boolean = false) {
        dir.mkdirs()
        val sdk =
            System.getenv("ANDROID_HOME")
                ?: System.getenv("ANDROID_SDK_ROOT")
                ?: File(System.getProperty("user.home"), "Library/Android/sdk").path
        write("local.properties", "sdk.dir=$sdk")
        write(
            "gradle.properties",
            """
            org.gradle.configuration-cache=true
            org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8
            android.useAndroidX=true
            kotlin.code.style=official
            """,
        )
        write(
            ".editorconfig",
            """
            root = true

            [*.{kt,kts}]
            indent_size = 4
            """,
        )
        write(
            "gradle/libs.versions.toml",
            """
            [versions]
            app-name = "dev.kit.fixture"
            app-android-sdk-compile = "37"
            app-android-sdk-target = "37"
            app-android-sdk-min = "30"
            app-jvm-target = "21"
            app-android-version = "1.2.3"
            app-ios-version = "1.2.3"
            ktlint = "1.8.0"
            """,
        )
        write(
            "settings.gradle.kts",
            """
            pluginManagement {
                repositories {
                    exclusiveContent {
                        forRepository { maven(file("$testRepo")) }
                        filter { includeGroupAndSubgroups("io.github.jordond.kit") }
                    }
                    gradlePluginPortal()
                    google()
                    mavenCentral()
                }
                resolutionStrategy.eachPlugin {
                    if (requested.id.id.startsWith("io.github.jordond.kit")) useVersion("$kitVersion")
                }
            }
            plugins {
                id("io.github.jordond.kit.settings")
            }
            rootProject.name = "fixture"
            include(":shared", ":android")
            ${if (withB3) "include(\":android:baseline\", \":server\")" else ""}
            """,
        )
        write(
            "build.gradle.kts",
            """
            plugins {
                id("org.jetbrains.kotlin.multiplatform") version "${cell.kotlin}" apply false
                id("org.jetbrains.kotlin.jvm") version "${cell.kotlin}" apply false
                id("org.jetbrains.kotlin.plugin.compose") version "${cell.kotlin}" apply false
                id("org.jetbrains.compose") version "${cell.compose}" apply false
                id("com.android.application") version "${cell.agp}" apply false
                id("com.android.kotlin.multiplatform.library") version "${cell.agp}" apply false
                ${if (withB3) "id(\"com.android.test\") version \"${cell.agp}\" apply false" else ""}
                ${if (withB3) "id(\"androidx.baselineprofile\") version \"$BASELINE_PROFILE\" apply false" else ""}
                id("com.diffplug.spotless") version "$SPOTLESS" apply false
                id("io.github.jordond.kit.lint")
            }
            """,
        )
        write(
            "shared/build.gradle.kts",
            """
            plugins {
                id("io.github.jordond.kit.kmp.library")
                id("io.github.jordond.kit.compose")
                id("io.github.jordond.kit.release")
            }
            kit {
                targets {
                    android()
                    jvm()
                    ios()
                }
                ios { frameworkName = "Shared" }
            }
            """,
        )
        write(
            "shared/src/commonMain/kotlin/dev/kit/fixture/shared/Version.kt",
            """
            package dev.kit.fixture.shared

            import androidx.compose.foundation.text.BasicText
            import androidx.compose.runtime.Composable
            import dev.kit.fixture.core.platform.BuildConstants

            fun version(): String = BuildConstants.VERSION_NAME + "/" + BuildConstants.VERSION_CODE

            @Composable
            fun Version() {
                BasicText(version())
            }
            """,
        )
        write(
            "android/build.gradle.kts",
            """
            plugins {
                id("io.github.jordond.kit.android.application")
                id("io.github.jordond.kit.release")
                ${if (withB3) "id(\"io.github.jordond.kit.android.baseline\")" else ""}
            }
            kit {
                applicationId = "dev.kit.fixture.app"
                ${if (withB3) "producer = \":android:baseline\"" else ""}
            }
            android {
                buildTypes {
                    getByName("release") {
                        // R8 is kit's default; off here to keep the matrix fast.
                        isMinifyEnabled = false
                        isShrinkResources = false
                    }
                }
            }
            dependencies {
                implementation(projects.shared) // typesafe accessors come from kit.settings
            }
            """,
        )
        write(
            "android/src/main/AndroidManifest.xml",
            """
            <?xml version="1.0" encoding="utf-8"?>
            <manifest xmlns:android="http://schemas.android.com/apk/res/android">
                <application android:label="fixture" />
            </manifest>
            """,
        )
        if (withB3) writeB3()
    }

    private fun writeB3() {
        write(
            "android/baseline/build.gradle.kts",
            """
            plugins {
                id("com.android.test")
                id("io.github.jordond.kit.android.baseline")
            }
            """,
        )
        write(
            "android/baseline/src/main/AndroidManifest.xml",
            """
            <?xml version="1.0" encoding="utf-8"?>
            <manifest />
            """,
        )
        write(
            "server/build.gradle.kts",
            """
            plugins {
                id("io.github.jordond.kit.jvm.app")
            }
            kit {
                application("dev.kit.fixture.server.MainKt")
            }
            """,
        )
        write(
            "server/src/main/kotlin/dev/kit/fixture/server/Main.kt",
            """
            package dev.kit.fixture.server

            fun main() {
                println("kit-server " + Runtime.version().feature())
            }
            """,
        )
    }

    companion object {
        const val SPOTLESS = "8.10.4"
        const val BASELINE_PROFILE = "1.5.0"
    }
}

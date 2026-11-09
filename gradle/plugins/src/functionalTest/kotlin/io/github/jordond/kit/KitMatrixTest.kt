package io.github.jordond.kit

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicContainer
import org.junit.jupiter.api.DynamicContainer.dynamicContainer
import org.junit.jupiter.api.DynamicNode
import org.junit.jupiter.api.DynamicTest.dynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission
import java.util.Base64

/**
 * The TestKit matrix (PLAN §14). Each cell builds one fixture and runs these in order; the full set
 * runs at both min and max. B3 (android.baseline, jvm.app) is a configuration-level check at max.
 */
class KitMatrixTest {
    /** Fixtures live in build/kit-fixtures/<cell> so a failed run can be inspected. */
    private val tmp = File(System.getProperty("kit.fixturesDir") ?: error("kit.fixturesDir not set")).apply { deleteRecursively() }

    @TestFactory
    fun matrix(): List<DynamicNode> =
        KitMatrixCell.selected().map { cell ->
            val fixture by lazy { Fixture(File(tmp, cell.name), cell).also { it.create() } }
            val nodes =
                listOf(
                    dynamicTest("-Pkit.versionCode lands in the APK and BuildInfo") { versionsLand(fixture) },
                    dynamicTest("a changed -Pkit.versionCode reuses the configuration cache") { ccReused(fixture) },
                    dynamicTest("lint registers spotlessCheck") { lint(fixture) },
                    dynamicTest("an unsigned release build fails") { unsignedFails(fixture) },
                    dynamicTest("a release build signs from ANDROID_KEYSTORE_*") { signedFromEnv(fixture) },
                    dynamicTest("a missing catalog key fails naming it") { missingCatalogKey(fixture) },
                )
            val b3 =
                if (cell == KitMatrixCell.MAX) {
                    listOf(dynamicTest("android.baseline + jvm.app configure") { b3(Fixture(File(tmp, "b3"), cell)) })
                } else {
                    emptyList()
                }
            dynamicContainer(cell.toString(), nodes + b3) as DynamicContainer
        }

    private fun versionsLand(fixture: Fixture) {
        fixture.build(":android:assembleDebug", "-Pkit.versionCode=42", "-Pkit.versionName=9.9.9")
        val metadata = fixture.file("android/build/outputs/apk/debug/output-metadata.json").readText()
        assertTrue(metadata.contains("\"versionCode\": 42"), metadata)
        assertTrue(metadata.contains("\"versionName\": \"9.9.9\""), metadata)

        val buildInfo = buildInfo(fixture).readText()
        assertTrue(buildInfo.contains("package dev.kit.fixture.core.platform"), buildInfo)
        assertTrue(buildInfo.contains("internal object BuildConstants"), buildInfo)
        assertTrue(buildInfo.contains("VERSION_NAME: String = \"9.9.9\""), buildInfo)
        assertTrue(buildInfo.contains("VERSION_CODE: Int = 42"), buildInfo)
        assertTrue(buildInfo.contains("IS_INTERNAL: Boolean = false"), buildInfo)
        assertTrue(buildInfo.contains("GIT_SHA: String = \""), buildInfo)
    }

    private fun ccReused(fixture: Fixture) {
        val result = fixture.build(":android:assembleDebug", "-Pkit.versionCode=43", "-Pkit.versionName=9.9.9", "-Pkit.internal=true")
        assertTrue(result.output.contains("Configuration cache entry reused"), "expected a configuration cache hit")
        val metadata = fixture.file("android/build/outputs/apk/debug/output-metadata.json").readText()
        assertTrue(metadata.contains("\"versionCode\": 43"), metadata)
        val buildInfo = buildInfo(fixture).readText()
        assertTrue(buildInfo.contains("VERSION_CODE: Int = 43"), buildInfo)
        assertTrue(buildInfo.contains("IS_INTERNAL: Boolean = true"), buildInfo)
    }

    private fun lint(fixture: Fixture) {
        val result = fixture.build("spotlessCheck", "--dry-run")
        listOf(":spotlessCheck", ":shared:spotlessCheck", ":android:spotlessCheck", ":shared:spotlessKotlin").forEach {
            assertTrue(result.output.contains("$it SKIPPED"), "missing $it")
        }
    }

    private fun unsignedFails(fixture: Fixture) {
        val result = fixture.fail(":android:assembleRelease")
        assertTrue(result.output.contains(NO_SIGNING), result.output.takeLast(4000))
    }

    private fun signedFromEnv(fixture: Fixture) {
        val keystore = File(fixture.dir, "../${fixture.dir.name}-release.jks")
        keystore.delete()
        val keytool = File(System.getProperty("java.home"), "bin/keytool").path
        val process =
            ProcessBuilder(
                keytool, "-genkeypair", "-keystore", keystore.path, "-storepass", "kitpass1", "-keypass", "kitpass1",
                "-alias", "kit", "-keyalg", "RSA", "-keysize", "2048", "-validity", "365", "-dname", "CN=kit",
            ).redirectErrorStream(true).start()
        assertEquals(0, process.waitFor(), process.inputStream.bufferedReader().readText())

        val env =
            mapOf(
                "ANDROID_KEYSTORE_BASE64" to Base64.getEncoder().encodeToString(keystore.readBytes()),
                "ANDROID_KEYSTORE_ALIAS" to "kit",
                "ANDROID_KEYSTORE_PASSWORD" to "kitpass1",
            )
        fixture.build(":android:assembleRelease", env = env)

        val apk = fixture.file("android/build/outputs/apk/release/android-release.apk")
        assertTrue(apk.isFile, "no signed APK at $apk")
        val decoded = fixture.file("android/build/kit/signing/release.jks")
        assertTrue(decoded.isFile)
        assertEquals(
            setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE),
            Files.getPosixFilePermissions(decoded.toPath()),
        )
        val leaked = fixture.file(".gradle").walkTopDown().filter { it.extension in setOf("jks", "keystore") }.toList()
        assertTrue(leaked.isEmpty(), "keystore written under .gradle/: $leaked")
    }

    private fun missingCatalogKey(fixture: Fixture) {
        val catalog = fixture.file("gradle/libs.versions.toml")
        val original = catalog.readText()
        try {
            catalog.writeText(original.lines().filterNot { it.startsWith("app-android-sdk-min") }.joinToString("\n"))
            val result = fixture.fail("help")
            assertTrue(result.output.contains("has no version 'app-android-sdk-min'"), result.output.takeLast(4000))
        } finally {
            catalog.writeText(original)
        }
    }

    private fun b3(fixture: Fixture) {
        fixture.create(withB3 = true)
        val result = fixture.fail(":android:verifyBaselineProfile")
        assertTrue(result.output.contains("Baseline profile missing or empty"), result.output.takeLast(4000))
        val tasks = fixture.build(":android:baseline:tasks", "--all").output
        assertTrue(tasks.contains("pixel6Api34"), "managed device not registered")
        val run = fixture.build(":server:run").output
        assertTrue(run.contains("kit-server 21"), "jvm.app did not run on the catalog's JVM 21 toolchain")
    }

    private fun buildInfo(fixture: Fixture): File =
        fixture.file("shared/build/generated/kit/buildinfo/commonMain/kotlin/dev/kit/fixture/core/platform/BuildConstants.kt")

    private companion object {
        const val NO_SIGNING = "kit.release: no signing config; set ANDROID_KEYSTORE_* or pass -Pkit.keystoreFile"
    }
}

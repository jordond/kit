package io.github.jordond.kit

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import java.io.File
import java.util.Base64

/** Release-signing and namespace scenarios run in every matrix cell. */
internal object SigningScenarios {
    /** Distinctive so a leak anywhere is unambiguous. */
    const val PASSWORD = "kitLeakCanary-7319"
    private const val ALIAS = "kit"

    private fun keystore(fixture: Fixture): File {
        val keystore = File(fixture.dir.parentFile, "${fixture.dir.name}-release.jks")
        if (keystore.isFile) return keystore
        val keytool = File(System.getProperty("java.home"), "bin/keytool").path
        val process =
            ProcessBuilder(
                keytool, "-genkeypair", "-keystore", keystore.path, "-storepass", PASSWORD, "-keypass", PASSWORD,
                "-alias", ALIAS, "-keyalg", "RSA", "-keysize", "2048", "-validity", "365", "-dname", "CN=kit",
            ).redirectErrorStream(true).start()
        assertEquals(0, process.waitFor(), process.inputStream.bufferedReader().readText())
        return keystore
    }

    private fun releaseApk(fixture: Fixture) = fixture.file("android/build/outputs/apk/release/android-release.apk")

    private fun decoded(fixture: Fixture) = fixture.file("android/build/kit/signing/release.jks")

    fun fromEnv(fixture: Fixture) {
        val env =
            mapOf(
                "ANDROID_KEYSTORE_BASE64" to Base64.getEncoder().encodeToString(keystore(fixture).readBytes()),
                "ANDROID_KEYSTORE_ALIAS" to ALIAS,
                "ANDROID_KEYSTORE_PASSWORD" to PASSWORD,
            )
        val result = fixture.build(":android:assembleRelease", env = env)
        assertTrue(releaseApk(fixture).isFile, "no signed APK")
        assertFalse(decoded(fixture).exists(), "decoded keystore not deleted after the build")
        assertNoLeak(fixture, result.output)
    }

    fun fromKeystoreFile(fixture: Fixture) {
        releaseApk(fixture).delete()
        val env = mapOf("ANDROID_KEYSTORE_ALIAS" to ALIAS, "ANDROID_KEYSTORE_PASSWORD" to PASSWORD)
        val result = fixture.build(":android:assembleRelease", "-Pkit.keystoreFile=${keystore(fixture).path}", env = env)
        assertTrue(releaseApk(fixture).isFile, "no signed APK")
        assertNoLeak(fixture, result.output)
    }

    fun partialEnv(fixture: Fixture) {
        val base64 = Base64.getEncoder().encodeToString(keystore(fixture).readBytes())
        val noPassword = fixture.fail(":android:assembleRelease", env = mapOf("ANDROID_KEYSTORE_BASE64" to base64, "ANDROID_KEYSTORE_ALIAS" to ALIAS))
        assertTrue(noPassword.output.contains("set ANDROID_KEYSTORE_ALIAS and ANDROID_KEYSTORE_PASSWORD"), noPassword.output.takeLast(3000))
        val noAlias =
            fixture.fail(
                ":android:assembleRelease",
                "-Pkit.keystoreFile=${keystore(fixture).path}",
                env = mapOf("ANDROID_KEYSTORE_PASSWORD" to PASSWORD),
            )
        assertTrue(noAlias.output.contains("set ANDROID_KEYSTORE_ALIAS and ANDROID_KEYSTORE_PASSWORD"), noAlias.output.takeLast(3000))
        assertFalse(noAlias.output.contains(PASSWORD), "password printed in build output")
    }

    /** allowDebugFallback with an empty ANDROID_USER_HOME: AGP must create its debug keystore. */
    fun debugFallback(fixture: Fixture) {
        val script = fixture.file("android/build.gradle.kts")
        val original = script.readText()
        val home = File(fixture.dir.parentFile, "${fixture.dir.name}-android-home").apply { deleteRecursively(); mkdirs() }
        try {
            script.writeText(original.replace("kit {\n", "kit {\n    allowDebugFallback = true\n"))
            releaseApk(fixture).delete()
            val result = fixture.build(":android:assembleRelease", env = mapOf("ANDROID_USER_HOME" to home.path))
            assertTrue(releaseApk(fixture).isFile, "no debug-signed release APK")
            assertTrue(result.output.contains("signing release with the debug key"), "no fallback warning")
            assertTrue(File(home, "debug.keystore").isFile, "AGP did not create the debug keystore in ANDROID_USER_HOME")
        } finally {
            script.writeText(original)
        }
    }

    /** The password must not appear in output, nor in plain text anywhere under the fixture (build/, .gradle/). */
    private fun assertNoLeak(
        fixture: Fixture,
        output: String,
    ) {
        assertFalse(output.contains(PASSWORD), "password printed in build output")
        val needle = PASSWORD.toByteArray(Charsets.ISO_8859_1).toString(Charsets.ISO_8859_1)
        val hits =
            fixture.dir
                .walkTopDown()
                .filter { it.isFile && it.length() < 256L * 1024 * 1024 }
                .filter { it.readBytes().toString(Charsets.ISO_8859_1).contains(needle) }
                .toList()
        assertTrue(hits.isEmpty(), "password found in plain text: $hits")
    }

    /** Nested modules with the same leaf name get distinct namespaces; a real collision fails clearly. */
    fun nestedNamespaces(fixture: Fixture) {
        fixture.create()
        val module = { path: String ->
            fixture.write(
                "${path.removePrefix(":").replace(':', '/')}/build.gradle.kts",
                """
                plugins {
                    id("io.github.jordond.kit.kmp.library")
                }
                kit {
                    targets { android() }
                }
                val ns =
                    (kotlin as ExtensionAware).extensions
                        .getByType(com.android.build.api.dsl.KotlinMultiplatformAndroidLibraryTarget::class.java)
                        .namespace
                tasks.register("printNamespace") {
                    val value = ns
                    doLast { println("namespace=" + value) }
                }
                """,
            )
        }
        module(":core:ui")
        module(":feature:forecast:ui")
        val settings = fixture.file("settings.gradle.kts")
        settings.appendText("include(\":core:ui\", \":feature:forecast:ui\")\n")
        val out = fixture.build(":core:ui:printNamespace", ":feature:forecast:ui:printNamespace").output
        assertTrue(out.contains("namespace=dev.kit.fixture.core.ui"), out.takeLast(3000))
        assertTrue(out.contains("namespace=dev.kit.fixture.feature.forecast.ui"), out.takeLast(3000))

        module(":core-ui")
        settings.appendText("include(\":core-ui\")\n")
        val clash = fixture.fail("help").output
        assertTrue(clash.contains("both get the Android namespace 'dev.kit.fixture.core.ui'"), clash.takeLast(3000))
    }
}

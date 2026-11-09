package io.github.jordond.kit

import com.android.build.api.dsl.ApplicationExtension
import com.android.build.api.variant.ApplicationVariant
import com.android.build.api.variant.SigningConfig
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.Project
import org.gradle.api.Transformer
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.Provider
import org.gradle.api.provider.ValueSource
import org.gradle.api.provider.ValueSourceParameters
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import org.gradle.api.tasks.TaskProvider
import org.gradle.work.DisableCachingByDefault
import java.io.File
import java.io.Serializable
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.security.KeyStore
import java.util.Base64

internal const val NO_SIGNING_CONFIG =
    "kit.release: no signing config; set ANDROID_KEYSTORE_* or pass -Pkit.keystoreFile"

internal object SigningEnv {
    const val BASE64 = "ANDROID_KEYSTORE_BASE64"
    const val ALIAS = "ANDROID_KEYSTORE_ALIAS"
    const val PASSWORD = "ANDROID_KEYSTORE_PASSWORD"
    const val KEYSTORE_FILE_PROPERTY = "kit.keystoreFile"

    fun get(name: String): String? = System.getenv(name)?.takeIf { it.isNotBlank() }
}

/**
 * Release signing (PLAN §13.4). Nothing secret is read or decoded at configuration time on AGP 9.4+:
 *
 * - [KitReleaseSigningTask] (`kitReleaseSigning`) runs before the release variant's signing and
 *   packaging tasks. It decodes ANDROID_KEYSTORE_BASE64 into `build/kit/signing/release.jks` (0600),
 *   or checks -Pkit.keystoreFile, and fails with [NO_SIGNING_CONFIG] when neither is set.
 * - [KitKeystoreSource] (a ValueSource) resolves store file, alias and passwords; AGP 9.4+'s
 *   `SigningConfig.from(Provider<SigningConfigInfo>)` takes it lazily.
 * - AGP < 9.4 has no lazy signing API, so there the same ValueSource is read in finalizeDsl and fed to a
 *   `kitRelease` DSL signing config (a configuration input; the decode still happens in the task).
 *
 * A signing config the app sets on the release build type itself is left alone.
 */
internal class ReleaseSigning(
    private val project: Project,
    private val kit: KitExtension,
) {
    private val decodedKeystore = project.layout.buildDirectory.file("kit/signing/release.jks")
    private var appOwnsSigning = false

    private val keystore: Provider<KitKeystore> =
        project.providers.of(KitKeystoreSource::class.java) {
            parameters.keystoreFile.set(project.providers.gradleProperty(SigningEnv.KEYSTORE_FILE_PROPERTY))
            parameters.decodedFile.set(decodedKeystore)
            parameters.allowDebugFallback.set(kit.allowDebugFallback)
        }

    private val task: TaskProvider<KitReleaseSigningTask> =
        project.tasks.register("kitReleaseSigning", KitReleaseSigningTask::class.java) {
            group = "kit"
            description = "Prepares the release keystore (or fails when none is configured)."
            keystoreFile.set(project.providers.gradleProperty(SigningEnv.KEYSTORE_FILE_PROPERTY))
            decodedFile.set(decodedKeystore)
            allowDebugFallback.set(kit.allowDebugFallback)
        }

    fun finalizeDsl(dsl: ApplicationExtension) {
        val release = dsl.buildTypes.findByName(KitReleasePlugin.RELEASE) ?: return
        appOwnsSigning = release.signingConfig != null
        if (appOwnsSigning || supportsLazySigning) return

        val resolved = keystore.orNull ?: return
        release.signingConfig =
            dsl.signingConfigs.create("kitRelease") {
                storeFile = resolved.storeFile
                storePassword = resolved.storePassword
                keyAlias = resolved.keyAlias
                keyPassword = resolved.keyPassword
            }
    }

    fun wire(variant: ApplicationVariant) {
        if (appOwnsSigning) return
        if (supportsLazySigning) {
            fromProvider!!.invoke(variant.signingConfig, keystore.map(ToSigningConfigInfo()))
        }
        val v = variant.name.replaceFirstChar { it.uppercase() }
        val gated = setOf("validateSigning$v", "package$v", "package${v}Bundle", "sign${v}Bundle")
        project.tasks.named { it in gated }.configureEach { dependsOn(task) }
    }

    private companion object {
        /** `SigningConfig.from(Provider<SigningConfigInfo>)`, AGP 9.4+. kit compiles against 9.2.1. */
        val fromProvider =
            SigningConfig::class.java.methods.firstOrNull { method ->
                method.name == "from" && method.parameterTypes.singleOrNull() == Provider::class.java
            }

        val supportsLazySigning: Boolean get() = fromProvider != null
    }
}

internal data class KitKeystore(
    val storeFile: File,
    val keyAlias: String,
    val storePassword: String,
    val keyPassword: String,
) : Serializable

/**
 * Where the release keystore comes from, without touching its contents: -Pkit.keystoreFile, else the
 * path ANDROID_KEYSTORE_BASE64 decodes to, each with ANDROID_KEYSTORE_ALIAS / _PASSWORD (the key
 * password is the store password). Absent when incomplete, or the debug keystore with
 * allowDebugFallback.
 */
internal abstract class KitKeystoreSource : ValueSource<KitKeystore, KitKeystoreSource.Params> {
    interface Params : ValueSourceParameters {
        val keystoreFile: Property<String>
        val decodedFile: RegularFileProperty
        val allowDebugFallback: Property<Boolean>
    }

    override fun obtain(): KitKeystore? {
        val alias = SigningEnv.get(SigningEnv.ALIAS)
        val password = SigningEnv.get(SigningEnv.PASSWORD)
        val file =
            parameters.keystoreFile.orNull?.takeIf { it.isNotBlank() }?.let(::File)
                ?: SigningEnv.get(SigningEnv.BASE64)?.let { parameters.decodedFile.get().asFile }
        if (file != null && alias != null && password != null) return KitKeystore(file, alias, password, password)
        return if (parameters.allowDebugFallback.getOrElse(false)) debugKeystore() else null
    }

    private fun debugKeystore(): KitKeystore {
        val home = System.getenv("ANDROID_USER_HOME") ?: File(System.getProperty("user.home"), ".android").path
        return KitKeystore(File(home, "debug.keystore"), "androiddebugkey", "android", "android")
    }
}

/** KitKeystore -> AGP's SigningConfigInfo, built reflectively because it only exists from AGP 9.4. */
internal class ToSigningConfigInfo :
    Transformer<Any, KitKeystore>,
    Serializable {
    override fun transform(keystore: KitKeystore): Any {
        val type =
            Class.forName("com.android.build.api.variant.SigningConfigInfo", true, SigningConfig::class.java.classLoader)
        return type
            .getConstructor(File::class.java, String::class.java, String::class.java, String::class.java, String::class.java)
            .newInstance(keystore.storeFile, keystore.storePassword, keystore.keyAlias, keystore.keyPassword, KeyStore.getDefaultType())
    }
}

@DisableCachingByDefault(because = "Handles signing secrets")
abstract class KitReleaseSigningTask : DefaultTask() {
    @get:Internal
    abstract val keystoreFile: Property<String>

    @get:Internal
    abstract val decodedFile: RegularFileProperty

    @get:Internal
    abstract val allowDebugFallback: Property<Boolean>

    init {
        doNotTrackState("Reads signing secrets from the environment; never snapshot them")
    }

    @TaskAction
    fun prepare() {
        val file = keystoreFile.orNull?.takeIf { it.isNotBlank() }
        val base64 = SigningEnv.get(SigningEnv.BASE64)
        if (file == null && base64 == null) {
            if (allowDebugFallback.get()) {
                logger.warn("kit.release: no signing config; signing release with the debug key (allowDebugFallback)")
                return
            }
            throw GradleException(NO_SIGNING_CONFIG)
        }
        if (SigningEnv.get(SigningEnv.ALIAS) == null || SigningEnv.get(SigningEnv.PASSWORD) == null) {
            throw GradleException("kit.release: set ${SigningEnv.ALIAS} and ${SigningEnv.PASSWORD} for the release keystore")
        }
        if (file != null) {
            if (!File(file).isFile) throw GradleException("kit.release: -Pkit.keystoreFile=$file does not exist")
            return
        }
        val bytes =
            try {
                Base64.getMimeDecoder().decode(base64!!.trim())
            } catch (e: IllegalArgumentException) {
                throw GradleException("kit.release: ${SigningEnv.BASE64} is not valid base64", e)
            }
        writeOwnerOnly(decodedFile.get().asFile, bytes)
    }

    private fun writeOwnerOnly(
        target: File,
        bytes: ByteArray,
    ) {
        val path = target.toPath()
        Files.createDirectories(path.parent)
        Files.deleteIfExists(path)
        try {
            Files.createFile(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        } catch (_: UnsupportedOperationException) {
            Files.createFile(path)
        }
        Files.write(path, bytes)
    }
}

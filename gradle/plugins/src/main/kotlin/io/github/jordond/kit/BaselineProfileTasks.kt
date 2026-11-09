package io.github.jordond.kit

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.work.DisableCachingByDefault
import java.io.File
import java.security.MessageDigest

/**
 * The baseline-profile "contract" hash: SHA-256 over each file's root-relative path and bytes, in
 * absolute-path order. Same algorithm as WhaleSay's script, so existing stamps stay valid.
 */
internal object BaselineContract {
    fun hash(
        files: Set<File>,
        rootDir: File,
    ): String {
        val md = MessageDigest.getInstance("SHA-256")
        files.sortedBy { it.absolutePath }.forEach { file ->
            md.update(file.relativeTo(rootDir).path.toByteArray())
            md.update(file.readBytes())
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}

@DisableCachingByDefault(because = "Writes a tiny committed file")
abstract class WriteBaselineProfileStampTask : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val contract: ConfigurableFileCollection

    @get:Internal
    abstract val rootDirectory: DirectoryProperty

    @get:OutputFile
    abstract val stamp: RegularFileProperty

    @TaskAction
    fun write() {
        val hash = BaselineContract.hash(contract.asFileTree.files, rootDirectory.get().asFile)
        stamp.get().asFile.writeText("$hash\n")
    }
}

@DisableCachingByDefault(because = "A check with no outputs")
abstract class VerifyBaselineProfileTask : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val contract: ConfigurableFileCollection

    @get:Internal
    abstract val rootDirectory: DirectoryProperty

    @get:Internal
    abstract val profile: RegularFileProperty

    @get:Internal
    abstract val stamp: RegularFileProperty

    @get:Input
    abstract val generateTask: Property<String>

    init {
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun verify() {
        val regenerate = "Run `${generateTask.get()}` on an emulator-capable host and commit the result."
        val profileFile = profile.get().asFile
        if (!profileFile.isFile || profileFile.readText().isBlank()) {
            throw GradleException("Baseline profile missing or empty at ${profileFile.path}. $regenerate")
        }
        val stampFile =
            stamp.orNull?.asFile
                ?: throw GradleException("kit.android.baseline: set kit { producer = \":…\" } or kit { baselineStamp = … }")
        if (!stampFile.isFile) {
            throw GradleException("Baseline profile freshness stamp missing at ${stampFile.path}. $regenerate")
        }
        val expected = stampFile.readText().trim()
        val actual = BaselineContract.hash(contract.asFileTree.files, rootDirectory.get().asFile)
        if (expected != actual) {
            throw GradleException(
                "Baseline profile is STALE: the driven UI contract changed since it was generated.\n" +
                    "  expected $expected\n  actual   $actual\n" +
                    "$regenerate Commit the profile and ${stampFile.name}.",
            )
        }
        logger.lifecycle("Baseline profile present and fresh (contract hash $actual).")
    }
}

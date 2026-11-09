package io.github.jordond.kit

import com.android.build.api.dsl.ManagedVirtualDevice
import com.android.build.api.dsl.TestExtension
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import com.android.build.api.variant.TestAndroidComponentsExtension
import org.gradle.api.JavaVersion
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.withGroovyBuilder

/**
 * `io.github.jordond.kit.android.baseline`: Baseline Profiles on both ends (ported from WhaleSay).
 *
 * Consumer (`com.android.application`): androidx.baselineprofile with `dexLayoutOptimization`, the
 * producer dependency from `kit { producer = ":android:baseline" }`, debug signing for the
 * nonMinifiedRelease/benchmarkRelease build types the profile plugin adds, and two device-free
 * tasks: `verifyBaselineProfile` (committed profile present, contract stamp fresh) and
 * `writeBaselineProfileStamp` (runs after `generateBaselineProfile`).
 *
 * Producer (`com.android.test`): SDK levels and Java target from the catalog, the instrumentation
 * runner, `targetProjectPath` = the parent project, and a managed device from
 * `kit { device; deviceApi }` (default Pixel 6, API 34) used exclusively.
 */
class KitAndroidBaselinePlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.requireOneOf(PLUGIN, PluginIds.ANDROID_APPLICATION, PluginIds.ANDROID_TEST)
        project.pluginManager.withPlugin(PluginIds.ANDROID_APPLICATION) { consumer(project) }
        project.pluginManager.withPlugin(PluginIds.ANDROID_TEST) { producer(project) }
    }

    private fun consumer(project: Project) {
        project.applyRequired(PluginIds.BASELINE_PROFILE, PLUGIN)
        val kit = project.kitExtension()
        project.extensions.getByName("baselineProfile").withGroovyBuilder {
            setProperty("dexLayoutOptimization", true)
        }
        val components = project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
        components.finalizeDsl { dsl ->
            kit.producer.orNull?.let { path ->
                project.dependencies.add("baselineProfile", project.dependencies.project(mapOf("path" to path)))
            }
            listOf("nonMinifiedRelease", "benchmarkRelease").forEach { name ->
                dsl.buildTypes.findByName(name)?.signingConfig = dsl.signingConfigs.getByName("debug")
            }
        }

        val rootDir = project.rootProject.layout.projectDirectory
        val committedProfile = project.layout.projectDirectory.file("src/release/generated/baselineProfiles/baseline-prof.txt")
        val stampFile =
            kit.baselineStamp.orElse(
                kit.producer.map { path -> rootDir.dir(path.removePrefix(":").replace(':', '/')).file(STAMP) },
            )
        val generate = "${project.path.removeSuffix(":")}:generateBaselineProfile"

        val write =
            project.tasks.register("writeBaselineProfileStamp", WriteBaselineProfileStampTask::class.java) {
                description = "Records the contract hash next to the generated baseline profile."
                contract.from(kit.baselineContract)
                rootDirectory.set(rootDir)
                stamp.set(stampFile)
            }
        project.tasks.register("verifyBaselineProfile", VerifyBaselineProfileTask::class.java) {
            group = "verification"
            description = "Fails if the committed baseline profile is missing, empty or stale (no emulator)."
            contract.from(kit.baselineContract)
            rootDirectory.set(rootDir)
            profile.set(committedProfile)
            stamp.set(stampFile)
            generateTask.set(generate)
        }
        project.tasks.named { it == "generateBaselineProfile" }.configureEach { finalizedBy(write) }
    }

    private fun producer(project: Project) {
        project.applyRequired(PluginIds.BASELINE_PROFILE, PLUGIN)
        val kit = project.kitExtension()
        val catalog = KitCatalog(project, PLUGIN)
        val android = project.extensions.getByType(TestExtension::class.java)
        val java = JavaVersion.toVersion(catalog.require(KitCatalog.JVM_TARGET, "Java/Kotlin bytecode target"))
        android.compileSdk = catalog.requireInt(KitCatalog.SDK_COMPILE, "Android compileSdk")
        android.defaultConfig.minSdk = catalog.requireInt(KitCatalog.SDK_MIN, "Android minSdk")
        android.defaultConfig.targetSdk = catalog.requireInt(KitCatalog.SDK_TARGET, "Android targetSdk")
        android.defaultConfig.testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        android.compileOptions.sourceCompatibility = java
        android.compileOptions.targetCompatibility = java

        val components = project.extensions.getByType(TestAndroidComponentsExtension::class.java)
        components.finalizeDsl { dsl ->
            if (dsl.namespace == null) {
                dsl.namespace = "${catalog.require(KitCatalog.APP_NAME, "producer namespace <app-name>.baselineprofile")}.baselineprofile"
            }
            if (dsl.targetProjectPath == null) {
                dsl.targetProjectPath = project.parent?.path
            }
            val hardware = kit.device.get()
            val api = kit.deviceApi.get()
            val name = hardware.lowercase().replace(Regex("[^a-z0-9]"), "") + "Api$api"
            if (dsl.testOptions.managedDevices.allDevices.findByName(name) == null) {
                dsl.testOptions.managedDevices.allDevices.create(name, ManagedVirtualDevice::class.java) {
                    device = hardware
                    apiLevel = api
                    systemImageSource = "aosp"
                }
            }
            project.extensions.getByName("baselineProfile").withGroovyBuilder {
                @Suppress("UNCHECKED_CAST")
                val devices = getProperty("managedDevices") as MutableList<String>
                if (name !in devices) devices += name
                setProperty("useConnectedDevices", false)
            }
        }
    }

    internal companion object {
        const val PLUGIN = "android.baseline"
        const val STAMP = "baseline-profile.stamp"
    }
}

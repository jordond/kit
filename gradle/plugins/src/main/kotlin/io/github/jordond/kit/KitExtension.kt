package io.github.jordond.kit

import org.gradle.api.Action
import org.gradle.api.Project
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import javax.inject.Inject

/**
 * The per-module `kit { }` block, shared by every kit project plugin. Each plugin reads only its own
 * options (see gradle/README.md). Signatures here never mention AGP, KGP or Compose types: those live
 * in the method bodies of the helpers they call, so a project without one of them still loads this class.
 */
abstract class KitExtension
    @Inject
    constructor(
        private val project: Project,
    ) {
        // --- release -------------------------------------------------------------------------------

        /** Sign release builds with the debug key when no keystore is configured, instead of failing. */
        abstract val allowDebugFallback: Property<Boolean>

        /** Where and how `BuildConstants` is generated into commonMain. */
        val buildInfo: KitBuildInfoSpec = project.objects.newInstance(KitBuildInfoSpec::class.java)

        fun buildInfo(action: Action<KitBuildInfoSpec>) = action.execute(buildInfo)

        // --- kmp.library ---------------------------------------------------------------------------

        /** Declares the KMP targets: `targets { android(); ios(); jvm(); js() }`. */
        fun targets(action: Action<KitTargets>) = action.execute(KitTargets(project, ios))

        /** Extra opt-ins on top of kit's shared set, for every source set. */
        abstract val optIns: ListProperty<String>

        /** iOS framework options; applies to frameworks declared before or after this block. */
        val ios: KitIosSpec = KitIosSpec(project)

        fun ios(action: Action<KitIosSpec>) {
            action.execute(ios)
            ios.apply()
        }

        /** Kotlin explicit API mode (strict). Applied immediately. */
        var explicitApi: Boolean = false
            set(value) {
                field = value
                KmpSupport.explicitApi(project, value)
            }

        // --- compose -------------------------------------------------------------------------------

        /** Adds `components-resources` to commonMain (default true). */
        abstract val resources: Property<Boolean>

        /** Applies org.jetbrains.compose.hot-reload (must be on the root classpath). Applied immediately. */
        var hotReload: Boolean = false
            set(value) {
                field = value
                if (value) project.applyRequired(PluginIds.COMPOSE_HOT_RELOAD, "compose")
            }

        // --- android.application -------------------------------------------------------------------

        /** Defaults to the namespace. */
        abstract val applicationId: Property<String>

        /** Defaults to catalog `app-name`; a namespace set in the `android { }` DSL wins. */
        abstract val namespace: Property<String>

        /** Core library desugaring (adds desugar_jdk_libs; catalog version `desugar-jdk-libs` overrides). */
        abstract val desugaring: Property<Boolean>

        /** Extra packaging resource excludes, on top of `/META-INF/{AL2.0,LGPL2.1}`. */
        abstract val packagingExcludes: ListProperty<String>

        // --- android.baseline ----------------------------------------------------------------------

        /** Consumer side: path of the `com.android.test` module that generates the profile. */
        abstract val producer: Property<String>

        /** Producer side: managed device hardware profile (default "Pixel 6"). */
        abstract val device: Property<String>

        /** Producer side: managed device API level (default 34). */
        abstract val deviceApi: Property<Int>

        /** Consumer side: files whose change makes the committed profile stale (`verifyBaselineProfile`). */
        abstract val baselineContract: ConfigurableFileCollection

        /** Consumer side: the freshness stamp (default `baseline-profile.stamp` in the producer's directory). */
        abstract val baselineStamp: RegularFileProperty

        // --- lint (root only) ----------------------------------------------------------------------

        /** ktlint version; defaults to catalog version `ktlint`, then kit's pinned default. */
        abstract val ktlintVersion: Property<String>

        /** Extra spotless target excludes (globs relative to each project). */
        abstract val excludes: ListProperty<String>

        /** Also lint the root build.gradle.kts and settings.gradle.kts (default false). */
        abstract val lintRootScripts: Property<Boolean>

        // --- jvm.app -------------------------------------------------------------------------------

        /** JVM toolchain/target; defaults to catalog `app-jvm-target`. */
        abstract val jvmTarget: Property<Int>

        /** Makes the module a runnable JVM application (applies `application`). Applied immediately. */
        fun application(mainClass: String) = JvmAppSupport.application(project, mainClass)

        init {
            allowDebugFallback.convention(false)
            resources.convention(true)
            desugaring.convention(false)
            device.convention("Pixel 6")
            deviceApi.convention(34)
            lintRootScripts.convention(false)
        }
    }

abstract class KitBuildInfoSpec {
    /** Package of the generated object; defaults to `<catalog app-name>.core.platform`. */
    abstract val packageName: Property<String>

    /** Name of the generated object (default `BuildConstants`). */
    abstract val className: Property<String>

    /** Generate it `public` instead of `internal` (default false). */
    abstract val publicApi: Property<Boolean>

    init {
        className.convention("BuildConstants")
        publicApi.convention(false)
    }
}

internal fun Project.kitExtension(): KitExtension =
    extensions.findByType(KitExtension::class.java)
        ?: extensions.create("kit", KitExtension::class.java, this)

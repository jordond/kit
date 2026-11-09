package io.github.jordond.kit

import com.android.build.api.dsl.ApplicationExtension
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import org.gradle.api.JavaVersion
import org.gradle.api.Plugin
import org.gradle.api.Project

/**
 * `io.github.jordond.kit.android.application`: an Android app module with kit's defaults.
 *
 * At apply time (so the module's own `android { }` overrides them): SDK levels and Java
 * compatibility from the catalog, packaging excludes, release minify + resource shrinking with the
 * default optimize proguard file (plus `proguard-rules.pro` when present), and the Compose build
 * feature when the Compose compiler plugin is applied. At finalizeDsl: namespace and applicationId
 * when the DSL left them unset, desugaring, and extra packaging excludes from `kit { }`.
 */
class KitAndroidApplicationPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        project.applyRequired(PluginIds.ANDROID_APPLICATION, PLUGIN)
        val kit = project.kitExtension()
        val catalog = KitCatalog(project, PLUGIN)
        val android = project.extensions.getByType(ApplicationExtension::class.java)

        val java = JavaVersion.toVersion(catalog.require(KitCatalog.JVM_TARGET, "Java/Kotlin bytecode target"))
        android.compileSdk = catalog.requireInt(KitCatalog.SDK_COMPILE, "Android compileSdk")
        android.defaultConfig.minSdk = catalog.requireInt(KitCatalog.SDK_MIN, "Android minSdk")
        android.defaultConfig.targetSdk = catalog.requireInt(KitCatalog.SDK_TARGET, "Android targetSdk")
        android.compileOptions.sourceCompatibility = java
        android.compileOptions.targetCompatibility = java
        android.packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        android.buildTypes.getByName("release").apply {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(android.getDefaultProguardFile("proguard-android-optimize.txt"))
            project.file("proguard-rules.pro").takeIf { it.isFile }?.let { proguardFiles(it) }
        }
        project.pluginManager.withPlugin(PluginIds.COMPOSE_COMPILER) {
            android.buildFeatures.compose = true
        }

        val components = project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
        components.finalizeDsl { dsl ->
            if (dsl.namespace == null) {
                val namespace =
                    kit.namespace.orNull
                        ?: catalog.require(KitCatalog.APP_NAME, "default namespace; or set kit { namespace = … }")
                // The app module takes `app-name` itself (not path-derived): one app module per build.
                KitNamespaces.claim(project, namespace, PLUGIN)
                dsl.namespace = namespace
            }
            if (dsl.defaultConfig.applicationId == null) {
                dsl.defaultConfig.applicationId = kit.applicationId.orNull ?: dsl.namespace
            }
            dsl.packaging.resources.excludes += kit.packagingExcludes.get()
            if (kit.desugaring.get()) {
                dsl.compileOptions.isCoreLibraryDesugaringEnabled = true
                val version = catalog.version("desugar-jdk-libs") ?: DESUGAR_JDK_LIBS
                project.dependencies.add("coreLibraryDesugaring", "com.android.tools:desugar_jdk_libs:$version")
            }
        }
    }

    private companion object {
        const val PLUGIN = "android.application"
        const val DESUGAR_JDK_LIBS = "2.1.5"
    }
}

plugins {
    `kotlin-dsl`
}

kotlin { jvmToolchain(21) }

dependencies {
    // Never bundled: each app's root `plugins { alias(...) apply false }` puts the real versions on the
    // classpath. Compile against the lowest version in use so kit never forces an upgrade.
    compileOnly("com.android.tools.build:gradle-api:9.2.1")
    compileOnly("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.0")
    compileOnly("org.jetbrains.compose:compose-gradle-plugin:1.11.1")
    compileOnly("com.diffplug.spotless:spotless-plugin-gradle:8.8.0")
}

gradlePlugin {
    plugins {
        fun plugin(
            name: String,
            id: String,
            implementation: String,
        ) = register(name) {
            this.id = "io.github.jordond.kit.$id"
            implementationClass = "io.github.jordond.kit.$implementation"
        }
        plugin("kitRelease", "release", "KitReleasePlugin")
        plugin("kitLint", "lint", "KitLintPlugin")
        plugin("kitKmpLibrary", "kmp.library", "KitKmpLibraryPlugin")
        plugin("kitCompose", "compose", "KitComposePlugin")
        plugin("kitAndroidApplication", "android.application", "KitAndroidApplicationPlugin")
        plugin("kitAndroidBaseline", "android.baseline", "KitAndroidBaselinePlugin")
        plugin("kitJvmApp", "jvm.app", "KitJvmAppPlugin")
    }
}

// TestKit functional tests. Fixtures resolve kit exactly as apps do: from a file Maven repo (here
// build/kit-test-repo instead of node_modules), so the settings/project classloader split is covered.
// Matrix cells: -Pkit.matrix=min | max | all (default all). See KitMatrix in src/functionalTest.
@Suppress("UnstableApiUsage")
testing {
    suites {
        register<JvmTestSuite>("functionalTest") {
            useJUnitJupiter("5.13.4")
            dependencies {
                implementation(gradleTestKit())
            }
            targets.all {
                testTask.configure {
                    dependsOn(":kit-plugins:publishAllPublicationsToKitTestRepository")
                    dependsOn(":kit-settings:publishAllPublicationsToKitTestRepository")
                    val repo = rootProject.layout.buildDirectory.dir("kit-test-repo")
                    systemProperty("kit.testRepo", repo.get().asFile.absolutePath)
                    systemProperty("kit.version", project.version.toString())
                    systemProperty("kit.matrix", providers.gradleProperty("kit.matrix").getOrElse("all"))
                    // Reuse the caller's Gradle user home so AGP/KGP/Compose aren't downloaded per run.
                    systemProperty("kit.testKitDir", gradle.gradleUserHomeDir.absolutePath)
                    maxParallelForks = 1
                    testLogging {
                        events("passed", "skipped", "failed")
                        showStandardStreams = providers.gradleProperty("kit.testOutput").isPresent
                        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
                    }
                }
            }
        }
    }
}

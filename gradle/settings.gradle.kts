// kit's Gradle convention plugins. Built and published into ./maven (a file Maven repo shipped
// inside the npm package as gradle/maven). Also consumed directly via includeBuild when an app
// sets KIT_GRADLE_DEV to this directory.
rootProject.name = "kit-gradle"

pluginManagement {
    repositories {
        gradlePluginPortal()
    }
}

plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositories {
        google {
            mavenContent {
                includeGroupAndSubgroups("com.android")
                includeGroupAndSubgroups("com.google")
                includeGroupAndSubgroups("androidx")
            }
        }
        mavenCentral()
    }
}

// Two artifacts on purpose: the settings plugin is loaded into the settings classloader, which is a
// parent of every project classloader but cannot see AGP/KGP. If project plugins lived in the same
// jar, Gradle would reuse that settings-loaded copy and fail with NoClassDefFoundError on AGP types.
include(":kit-settings")
project(":kit-settings").projectDir = file("settings")
include(":kit-plugins")
project(":kit-plugins").projectDir = file("plugins")

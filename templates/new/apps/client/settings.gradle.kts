pluginManagement {
    // Walk up from the Gradle root to the repo's node_modules (works for apps/client and repo-root builds).
    val kit = generateSequence(settingsDir) { it.parentFile }
        .map { it.resolve("node_modules/@jordond/kit") }
        .firstOrNull { it.resolve("package.json").isFile }
        ?: error("kit not installed: run `bun install` at the repo root")
    val kitVersion = (groovy.json.JsonSlurper().parse(kit.resolve("package.json")) as Map<*, *>)["version"] as String

    System.getenv("KIT_GRADLE_DEV")?.let { includeBuild(it) }       // kit dev loop: use a kit checkout's gradle/
    repositories {
        exclusiveContent {
            forRepository { maven(kit.resolve("gradle/maven")) }
            filter { includeGroupAndSubgroups("io.github.jordond.kit") }
        }
        gradlePluginPortal(); google(); mavenCentral()
    }
    resolutionStrategy.eachPlugin {
        if (requested.id.id.startsWith("io.github.jordond.kit")) useVersion(kitVersion)
    }
}
plugins { id("io.github.jordond.kit.settings") }

rootProject.name = "{{name}}"

include(":shared", ":android")

import groovy.json.JsonSlurper

// One pin: the plugin version is kit's npm version.
val kitVersion: String =
    (JsonSlurper().parse(layout.projectDirectory.file("../package.json").asFile) as Map<*, *>)["version"] as String

allprojects {
    group = "io.github.jordond.kit"
    version = kitVersion
}

subprojects {
    apply(plugin = "maven-publish")
    extensions.configure<PublishingExtension> {
        repositories {
            maven {
                name = "kit"
                url = uri(rootProject.layout.projectDirectory.dir("maven"))
            }
            // Functional tests resolve the plugins from here, the same way apps resolve gradle/maven.
            maven {
                name = "kitTest"
                url = uri(rootProject.layout.buildDirectory.dir("kit-test-repo"))
            }
        }
    }
}

// `./gradlew publishKit` -> gradle/maven, the file repo the npm tarball ships.
tasks.register("publishKit") {
    group = "publishing"
    dependsOn(subprojects.map { "${it.path}:publishAllPublicationsToKitRepository" })
}

// `./gradlew kitMatrix [-Pkit.matrix=min|max|all]`: the TestKit matrix CI calls.
tasks.register("kitMatrix") {
    group = "verification"
    description = "Runs the TestKit functional tests across the AGP/Kotlin matrix (-Pkit.matrix=min|max|all)."
    dependsOn(":kit-plugins:functionalTest")
}

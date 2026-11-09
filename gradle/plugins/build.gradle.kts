plugins {
    `kotlin-dsl`
}

kotlin { jvmToolchain(21) }

dependencies {
    // Never bundled: each app's own AGP is on the classpath. Compile against the lowest in use.
    compileOnly("com.android.tools.build:gradle-api:9.2.1")
}

gradlePlugin {
    plugins {
        register("kitRelease") {
            id = "io.github.jordond.kit.release"
            implementationClass = "io.github.jordond.kit.KitReleasePlugin"
        }
    }
}

plugins {
    `kotlin-dsl`
}

kotlin { jvmToolchain(21) }

gradlePlugin {
    plugins {
        register("kitSettings") {
            id = "io.github.jordond.kit.settings"
            implementationClass = "io.github.jordond.kit.KitSettingsPlugin"
        }
    }
}

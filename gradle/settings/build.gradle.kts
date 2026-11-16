plugins {
    `kotlin-dsl`
}

kotlin { jvmToolchain(21) }

gradlePlugin {
    plugins {
        register("kitSettings") {
            id = "dev.jordond.kit.settings"
            implementationClass = "dev.jordond.kit.KitSettingsPlugin"
        }
    }
}

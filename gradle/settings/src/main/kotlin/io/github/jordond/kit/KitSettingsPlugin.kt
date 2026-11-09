package io.github.jordond.kit

import org.gradle.api.Plugin
import org.gradle.api.initialization.Settings

/** `io.github.jordond.kit.settings`: shared settings conventions (spike scope: project accessors). */
class KitSettingsPlugin : Plugin<Settings> {
    override fun apply(settings: Settings) {
        // Idempotent: apps that already enable it are unaffected.
        settings.enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")
    }
}

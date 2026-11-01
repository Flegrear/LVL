// LVL's extension runner. Dependencies follow the pinned
// Suwayomi version catalog (.vendor, made by fetch.mjs).
rootProject.name = "lvl-ext-runner"

pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    versionCatalogs {
        create("libs") {
            from(files(".vendor/suwayomi/gradle/libs.versions.toml"))
        }
    }
}

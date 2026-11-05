pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Injekt on Koin and java-nat-sort, which Mihon/Tachiyomi extensions use, are only on JitPack.
        maven("https://jitpack.io") {
            content {
                includeGroup("com.github.null2264")
                includeGroup("com.github.gpanther")
            }
        }
    }
}

rootProject.name = "lvl-android"
include(":app")

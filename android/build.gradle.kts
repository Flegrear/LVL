// The Tachiyomi source API the Comics extension host compiles (from Suwayomi, see
// ext-runner/fetch.mjs) and its libraries are built with Kotlin 2.4, newer than the
// Kotlin that the Android Gradle Plugin brings; a newer Kotlin Gradle plugin on the build
// classpath replaces AGP's own.
buildscript {
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.10")
    }
}

plugins {
    id("com.android.application") version "9.5.0" apply false
}

// Build output goes to the worktree's ignored build/ folder, not next to the sources.
layout.buildDirectory.set(rootDir.resolve("../build/android-gradle/root"))

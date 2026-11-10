// LVL's extension runner: runs Mihon/Tachiyomi extensions
// (Android APKs) on the JVM with Suwayomi's Android layer, for LVL's Comics.
// Build: node ext-runner/build.mjs (fetches the pinned sources, builds, makes the runtime).
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.security.MessageDigest

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

repositories {
    mavenCentral()
    google()
    // This Android jar matches the pinned Suwayomi sources; the android-jar branch moves.
    maven("https://raw.githubusercontent.com/Suwayomi/Suwayomi-Server/3983289d9481a8ba99c0b16350b27f41364906a2/")
    maven("https://jitpack.io")
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        freeCompilerArgs.addAll("-Xcontext-parameters", "-opt-in=kotlinx.serialization.ExperimentalSerializationApi")
    }
}

sourceSets {
    main {
        // Suwayomi's sources (Java and Kotlin mixed), copied by fetch.mjs.
        java.srcDir(".vendor/src/main/java")
        kotlin.srcDir(".vendor/src/main/java")
        resources.srcDir(".vendor/src/main/resources")
    }
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    doFirst { verifyAndroidJar(classpath.files) }
}

fun verifyAndroidJar(files: Iterable<java.io.File>) {
    val matches = files.filter { it.name == "android-jar-1.0.0.jar" }
    check(matches.size == 1) { "Expected one Suwayomi android-jar:1.0.0 on the classpath" }
    val digest = MessageDigest.getInstance("SHA-256").digest(matches.single().readBytes())
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    check(digest == "2743be4f4c9ba50f8c86ccc0769e5be5246542488b34e6085a2574ca8ac303e3") {
        "Suwayomi android-jar:1.0.0 differs from the pinned Android compatibility API"
    }
}

dependencies {
    // What extensions and the Android layer use (Suwayomi's "shared" bundle without JCEF).
    implementation(libs.kotlin.stdlib.jdk8)
    implementation(libs.kotlin.reflect)
    implementation(libs.coroutines.core)
    implementation(libs.coroutines.jdk8)
    implementation(libs.serialization.json)
    implementation(libs.serialization.json.okio)
    implementation(libs.serialization.protobuf)
    implementation(libs.koin.core)
    implementation(libs.slf4japi)
    implementation(libs.logback)
    implementation(libs.kotlinlogging)
    implementation(libs.appdirs)
    implementation(libs.rxjava)
    implementation(libs.jsoup)
    implementation(libs.config)
    implementation(libs.config4k)
    implementation(libs.injekt)
    implementation(libs.sort)
    implementation(libs.jackson.annotations)
    implementation(libs.bundles.okhttp)
    implementation(libs.okio)

    // APK to JVM: dex2jar, its ASM, and the APK manifest reader.
    implementation(libs.dex2jar.translator)
    implementation(libs.dex2jar.tools)
    implementation(libs.asm)
    implementation(libs.apk.parser)
    implementation(libs.axml)

    // Android: stub jar plus AndroidCompat's own classes (which come first on the class path).
    implementation(libs.android.stubs)
    compileOnly(libs.xmlpull)
    // Desktop APK admission executes apksig at runtime (v1/v2/v3/v3.1 verification).
    implementation(libs.apksig)
    compileOnly(libs.android.annotations)
    implementation(libs.bundles.settings)
    implementation(libs.icu4j)
    implementation(libs.bundles.twelvemonkeys)
    implementation(libs.imageio.webp)

    // QuickJS substitute (some extensions run site scripts).
    implementation(libs.bundles.polyglot)

    // AES/CBC/PKCS7Padding for some extensions.
    implementation(libs.bouncycastle)
}

tasks.jar {
    archiveFileName.set("lvl-ext-runner.jar")
    manifest { attributes("Main-Class" to "lvl.runner.MainKt", "Multi-Release" to "true") }
}

// build/dist: lvl-ext-runner.jar + lib/*.jar (POM-only artifacts left out).
tasks.register<Sync>("dist") {
    dependsOn(tasks.jar)
    doFirst { verifyAndroidJar(configurations.runtimeClasspath.get().files) }
    from(tasks.jar)
    from(configurations.runtimeClasspath.map { files -> files.filter { it.name.endsWith(".jar") } }) { into("lib") }
    into(layout.buildDirectory.dir("dist"))
    // Made by build.mjs (jlink, notice), not by this task.
    preserve { include("runtime/**", "NOTICE.txt") }
}

import groovy.json.JsonSlurper
import javax.inject.Inject

plugins {
    id("com.android.application")
}

val worktree = rootDir.resolve("..")
val stage = worktree.resolve("build/android-stage")
// Android's public version is independent of the desktop version. The explicit code
// never rolls back when a former test APK used 0.2.4 (204).
@Suppress("UNCHECKED_CAST")
val androidVersion = JsonSlurper().parse(rootDir.resolve("app-version.json")) as Map<String, Any>
val stagedManifest = stage.resolve("assets/lvl-app.json").takeIf { it.isFile }?.let {
    JsonSlurper().parse(it) as Map<String, Any>
}
val lvlVersion = stagedManifest?.get("version") as? String ?: androidVersion["version"] as String
val syntheticVersion = stagedManifest?.get("testVersionOverride") == true
require(syntheticVersion || lvlVersion == androidVersion["version"]) {
    "Stale Android stage; run android/stage-app.mjs before Gradle"
}
val lvlParts = lvlVersion.split(".").map { it.toInt() }
require(lvlParts.size == 3 && lvlParts.all { it >= 0 } && lvlParts[1] < 100 && lvlParts[2] < 100) {
    "Android versionCode requires X.Y.Z with Y and Z below 100"
}
val lvlVersionCode = if (syntheticVersion) {
    lvlParts.let { (major, minor, patch) -> major * 10000 + minor * 100 + patch }
} else {
    (androidVersion["versionCode"] as Number).toInt().also { require(it >= 205) { "Android versionCode cannot downgrade from debug 204" } }
}
require(syntheticVersion || stagedManifest == null || (stagedManifest["versionCode"] as? Number)?.toInt() == lvlVersionCode) {
    "Android staged versionCode disagrees with android/app-version.json"
}
// The signing key is supplied at build time; it never belongs in the repository.
val releaseSigningValues = listOf("LVL_ANDROID_KEYSTORE", "LVL_ANDROID_KEYSTORE_PASSWORD", "LVL_ANDROID_KEY_ALIAS", "LVL_ANDROID_KEY_PASSWORD")
    .map { System.getenv(it)?.takeIf(String::isNotBlank) }
val hasReleaseSigning = releaseSigningValues.all { it != null }

android {
    namespace = "io.github.flegrear.lvl"
    // OkHttp 5.5 (which extensions need) compiles only against Android 37's APIs; the app
    // still targets Android 16 (targetSdk), so its behaviour doesn't change.
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "io.github.flegrear.lvl"
        minSdk = 31
        targetSdk = 36
        versionCode = lvlVersionCode
        versionName = lvlVersion
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("lvlRelease") {
                storeFile = file(releaseSigningValues[0]!!)
                storePassword = releaseSigningValues[1]!!
                keyAlias = releaseSigningValues[2]!!
                keyPassword = releaseSigningValues[3]!!
            }
        }
    }

    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        getByName("release") {
            // Comics extensions call the app's classes (OkHttp, Jsoup, the source API) by
            // name, so nothing may be renamed or removed.
            isMinifyEnabled = false
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("lvlRelease")
        }
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(stage.resolve("assets"))
            jniLibs.srcDir(stage.resolve("jniLibs"))
        }
    }

    packaging {
        // Node and FFmpeg run as executables, so they must be extracted to the native library folder.
        jniLibs.useLegacyPackaging = true
        resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES")
    }

    // One APK per processor type, each with only its own Node, FFmpeg and libraries:
    // arm64-v8a for phones and tablets, x86_64 for emulators and Chromebooks.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }

    androidResources {
        // The app zip is already compressed.
        noCompress += "zip"
    }
}

// Compile and resource prerequisites may run without release credentials.
// Only tasks that can produce a final unsigned release APK/AAB require signing.
val finalReleaseArtifactTasks = setOf(
    "assembleRelease", "packageRelease", "bundleRelease", "signReleaseBundle",
    "packageReleaseBundle", "packageReleaseUniversalApk", "packageReleaseSplitApk",
)
gradle.taskGraph.whenReady {
    if (allTasks.any { it.name in finalReleaseArtifactTasks }) {
        require(hasReleaseSigning) { "Android release signing requires all LVL_ANDROID_KEY* environment variables and LVL_ANDROID_KEYSTORE" }
        require(file(releaseSigningValues[0]!!).isFile) { "Android release keystore file is missing" }
    }
}

kotlin {
    compilerOptions {
        // OkHttpExtensions.kt in the source API uses context parameters.
        freeCompilerArgs.addAll("-Xcontext-parameters", "-opt-in=kotlinx.serialization.ExperimentalSerializationApi")
    }
}

// The Tachiyomi source API that Comics extensions are compiled against, fetched from
// Suwayomi at the commit in ext-runner/suwayomi.json (node ext-runner/fetch.mjs). Only the
// parts that run on Android are copied: Suwayomi's App class and its JVM bytecode tools are
// left out; LVL's own AppInfo, AppModule, NetworkHelper and CloudflareInterceptor are in
// src/main/kotlin/eu/kanade/tachiyomi.
abstract class ExtensionApiSources : DefaultTask() {
    @get:InputDirectory
    abstract val vendor: DirectoryProperty

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @get:Inject
    abstract val files: FileSystemOperations

    @TaskAction
    fun copy() {
        files.sync {
            from(vendor) {
                include("eu/kanade/tachiyomi/**", "suwayomi/tachidesk/manga/impl/util/lang/**")
                exclude("eu/kanade/tachiyomi/App.kt")
            }
            into(output)
        }
    }
}

val extensionApiSources = tasks.register<ExtensionApiSources>("extensionApiSources") {
    vendor.set(worktree.resolve("ext-runner/.vendor/src/main/java"))
    output.set(layout.buildDirectory.dir("generated/extension-api"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.kotlin?.addGeneratedSourceDirectory(extensionApiSources, ExtensionApiSources::output)
    }
}

dependencies {
    // What extensions use at run time, at the versions the desktop extension runner uses
    // (Suwayomi's version catalog; OkHttp's major version is fixed by the extensions).
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json-okio:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-protobuf:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    implementation("com.squareup.okhttp3:logging-interceptor:5.5.0")
    implementation("com.squareup.okhttp3:okhttp-dnsoverhttps:5.5.0")
    implementation("com.squareup.okhttp3:okhttp-brotli:5.5.0")
    implementation("com.squareup.okhttp3:okhttp-zstd:5.5.0")
    implementation("com.squareup.okio:okio:3.18.2")
    implementation("org.jsoup:jsoup:1.23.2")
    implementation("io.reactivex:rxjava:1.3.8")
    implementation("io.insert-koin:koin-core:4.2.2")
    implementation("com.github.null2264:injekt-koin:ee267b2e27")
    implementation("com.github.gpanther:java-nat-sort:natural-comparator-1.1")
    implementation("androidx.preference:preference:1.2.1")
    implementation("androidx.webkit:webkit:1.18.0")
    // QuickJS, for the few extensions that run a site's script.
    implementation("app.cash.quickjs:quickjs-android:0.9.2")
}

layout.buildDirectory.set(worktree.resolve("build/android-gradle/app"))

import java.util.Properties
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// The verifier's JVM bridge ships in the Cargo dependency, not a public Maven
// repository. Resolve its exact locked version and location with Cargo.
val rustlsAndroid = run {
    val metadata = providers.exec {
        commandLine("cargo", "metadata", "--format-version", "1", "--locked",
            "--filter-platform", "aarch64-linux-android",
            "--manifest-path", file("../../../Cargo.toml").absolutePath)
    }.standardOutput.asText.get()
    val packages = (JsonSlurper().parseText(metadata) as Map<*, *>)["packages"] as List<*>
    packages.map { it as Map<*, *> }.single { it["name"] == "rustls-platform-verifier-android" }
}

repositories {
    maven {
        url = uri(file(rustlsAndroid["manifest_path"] as String).parentFile.resolve("maven"))
        content { includeModule("rustls", "rustls-platform-verifier") }
    }
}

android {
    compileSdk = 36
    namespace = "com.bilikara.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.bilikara.app"
        minSdk = 24
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        targetSdk = 36
        versionCode = System.getenv("BILIKARA_ANDROID_VERSION_CODE")?.toInt()
            ?: tauriProperties.getProperty("tauri.android.versionCode", "8000").toInt()
        versionName = System.getenv("BILIKARA_ANDROID_VERSION_NAME") ?: "0.8.0-preview.0"
    }
    // No signing material lives in the repository. A tag build must supply all
    // four secrets; manual/PR builds remain clearly marked .alpha test packages.
    val signingPath = System.getenv("ANDROID_KEYSTORE_PATH")
    if (!signingPath.isNullOrBlank()) {
        signingConfigs.create("release") {
            storeFile = file(signingPath)
            storePassword = requireNotNull(System.getenv("ANDROID_KEYSTORE_PASSWORD"))
            keyAlias = requireNotNull(System.getenv("ANDROID_KEY_ALIAS"))
            keyPassword = requireNotNull(System.getenv("ANDROID_KEY_PASSWORD"))
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".alpha"
            // Only loopback is permitted by network_security_config.xml.
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            // Strip packaged JNI debug sections for a practical sideload APK.
            // Cargo's unstripped .so remains in target for crash symbolication;
            // this does not change Rust behavior or disable WebView debugging.
        }
        getByName("release") {
            if (!signingPath.isNullOrBlank()) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("rustls:rustls-platform-verifier:${rustlsAndroid["version"]}")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")

import java.util.Properties

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

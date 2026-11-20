// The kotlin-dsl plugin's own dependencies (Kotlin Gradle plugin, stdlib)
// live on Maven Central; resolve them there directly instead of through the
// plugin portal's redirect, which has failed transiently in CI.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
}

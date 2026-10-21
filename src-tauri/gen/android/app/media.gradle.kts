import com.android.build.api.dsl.ApplicationExtension
import com.android.build.api.variant.ApplicationAndroidComponentsExtension

// Tauri supplies abiList for its selected APK target. No desktop preparation or
// application Runtime is linked into the host-native construction tool.
val mediaAbis = (findProperty("abiList") as? String)?.split(',') ?: listOf("arm64-v8a")
require(mediaAbis.all { it in listOf("arm64-v8a", "x86_64") }) {
    "bilikara media output requires a 64-bit Android target (arm64-v8a or x86_64)"
}
val mediaRoot = file("../../../..")
val mediaOutput = layout.buildDirectory.dir("generated/bilikara-media")
val mediaCache = System.getenv("BILIKARA_ANDROID_LIBAV_CACHE")?.let { file(it) }
    ?: rootProject.layout.projectDirectory.dir(".gradle/bilikara-libav-cache").asFile
val androidExtension = extensions.getByType<ApplicationExtension>()
androidExtension.ndkVersion = "27.0.12077973"
val mediaNdk = extensions.getByType<ApplicationAndroidComponentsExtension>().sdkComponents.ndkDirectory
// The trusted Rust loader uses applicationInfo.nativeLibraryDir. Extraction
// gives it regular files and keeps APK zip compression independent of dlopen.
androidExtension.packaging.jniLibs.useLegacyPackaging = true
for (abi in mediaAbis) {
    androidExtension.sourceSets.getByName("main").jniLibs.srcDir(mediaOutput.map { it.dir("$abi/jniLibs") })
    androidExtension.sourceSets.getByName("main").assets.srcDir(mediaOutput.map { it.dir("$abi/assets") })
}
val prepareMedia = tasks.register("prepareBilikaraMedia") {
    group = "rust"
    description = "Build and verify the shared Android libav/Signalsmith companion"
    inputs.dir(mediaRoot.resolve("media-libav"))
    inputs.dir(mediaRoot.resolve("xtask/src"))
    inputs.files(mediaRoot.resolve("xtask/Cargo.toml"), mediaRoot.resolve("xtask/Cargo.lock"),
        mediaRoot.resolve("rust-toolchain.toml"), mediaRoot.resolve("THIRD_PARTY_NOTICES.md"))
    inputs.property("abis", mediaAbis.joinToString(","))
    inputs.file(mediaNdk.map { it.file("source.properties") })
    outputs.dir(mediaOutput)
    doLast {
        for (abi in mediaAbis) {
            project.exec {
                workingDir(mediaRoot)
                commandLine("cargo", "run", "--manifest-path", "xtask/Cargo.toml", "--locked",
                    "--target", "host-tuple", "--", "android-libav", "--ndk", mediaNdk.get().asFile.absolutePath,
                    "--abi", abi, "--out", mediaOutput.get().dir(abi).asFile.absolutePath,
                    "--cache", mediaCache.absolutePath)
                System.getenv("BILIKARA_LIBAV_SOURCE_DIR")?.let { args("--source-dir", it) }
            }.assertNormalExitValue()
        }
    }
}
tasks.matching { it.name.startsWith("merge") &&
    (it.name.endsWith("JniLibFolders") || it.name.endsWith("Assets")) }.configureEach {
    dependsOn(prepareMedia)
}

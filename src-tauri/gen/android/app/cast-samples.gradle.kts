import com.android.build.api.dsl.ApplicationExtension

// Test packages include the offline comparison clip by default. Distribution
// builds can opt out with -Pbilikara.includeCastSamples=false.
val includeCastSamples = providers.gradleProperty("bilikara.includeCastSamples")
    .map { it.toBooleanStrict() }.orElse(true)
val castSampleAssets = layout.buildDirectory.dir("generated/cast-sample-assets")
val prepareCastSamples = tasks.register("prepareBilikaraCastSamples") {
    inputs.property("includeCastSamples", includeCastSamples)
    val source = file("../../../../resources/cast-samples")
    inputs.files(source.resolve("sample-b.ts"), source.resolve("SOURCE.md"))
    outputs.dir(castSampleAssets)
    doLast {
        val target = castSampleAssets.get().dir("cast-samples").asFile
        for (name in listOf("sample-b.ts", "SOURCE.md")) {
            val output = target.resolve(name)
            if (includeCastSamples.get()) {
                target.mkdirs()
                source.resolve(name).copyTo(output, overwrite = true)
            } else if (output.exists()) {
                check(output.delete()) { "Cannot remove stale cast sample $name" }
            }
        }
    }
}
extensions.configure<ApplicationExtension> {
    sourceSets.getByName("main").assets.srcDir(castSampleAssets)
    androidResources.noCompress += listOf("ts", "md")
}
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
    dependsOn(prepareCastSamples)
}

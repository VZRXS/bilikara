package com.bilikara.app

import android.app.Activity
import androidx.annotation.Keep
import java.io.File

/** Fixed JNI entry points, holding only application storage/assets. */
@Keep
internal object HostCastSamples {
  private var files: CastSampleFiles? = null
  @JvmStatic @Synchronized fun initialize(activity: Activity): String {
    val app = activity.applicationContext
    val directory = File(app.cacheDir, "cast-samples")
    files = CastSampleFiles(directory, { app.assets.open("cast-samples/sample-b.ts") })
    files!!.cleanup() // Remove a copy left by process death, without extracting at startup.
    return directory.absolutePath
  }
  @JvmStatic fun prepare(): Int = files?.prepare() ?: CastSampleFiles.COPY_FAILED
  @JvmStatic fun cleanup() { files?.cleanup() }
}

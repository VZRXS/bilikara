package com.bilikara.app

import java.io.File
import java.io.IOException
import java.io.InputStream

/** Bounded streaming I/O only; the authoritative integrity check lives in Rust. */
internal class CastSampleFiles(
  val directory: File,
  private val openAsset: () -> InputStream,
  private val freeBytes: () -> Long = { directory.usableSpace },
  private val openOutput: (File) -> java.io.OutputStream = { it.outputStream() }
) {
  companion object {
    const val BYTES = 12079564L
    const val READY = 0
    const val NOT_INTEGRATED = 1
    const val NO_SPACE = 2
    const val COPY_FAILED = 3
  }
  @Synchronized fun prepare(): Int {
    return try {
      check(directory.isDirectory || directory.mkdirs())
      cleanup()
      val input = try { openAsset() } catch (_: java.io.FileNotFoundException) { return NOT_INTEGRATED }
      input.use {
        if (freeBytes() < BYTES + 1024 * 1024) return NO_SPACE
        val temporary = File(directory, "sample-b.ts.part")
        openOutput(temporary).use { output ->
          val buffer = ByteArray(64 * 1024)
          var count = 0L
          while (true) {
            val read = it.read(buffer)
            if (read < 0) break
            count += read
            if (count > BYTES) throw IOException("sample too large")
            output.write(buffer, 0, read)
          }
          if (count != BYTES) throw IOException("sample truncated")
          output.flush()
        }
        if (!temporary.renameTo(File(directory, "sample-b.ts"))) throw IOException("sample publish failed")
      }
      READY
    } catch (_: Exception) {
      if (freeBytes() < BYTES + 1024 * 1024) NO_SPACE else COPY_FAILED
    } finally {
      File(directory, "sample-b.ts.part").delete()
    }
  }
  @Synchronized fun cleanup() {
    // Fixed owned names only; never recursively delete the application's cache.
    for (name in listOf("sample-b.ts", "sample-b.ts.part")) {
      val file = File(directory, name)
      if (file.exists() && !file.delete()) throw IOException("sample cleanup failed")
    }
  }
}

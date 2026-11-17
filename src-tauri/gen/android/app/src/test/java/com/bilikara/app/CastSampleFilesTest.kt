package com.bilikara.app

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files

class CastSampleFilesTest {
  private fun stream(size: Long = CastSampleFiles.BYTES) = object : InputStream() {
    var remaining = size
    override fun read(): Int = if (remaining-- > 0) 71 else -1
    override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
      assertTrue("copy must stay bounded", length <= 64 * 1024)
      if (remaining == 0L) return -1
      val count = minOf(length.toLong(), remaining).toInt()
      bytes.fill(71, offset, offset + count); remaining -= count
      return count
    }
  }
  private fun directory() = Files.createTempDirectory("cast-samples-test").toFile()
  @Test fun streamsAndPublishesThenCleansOwnedFiles() {
    val directory = directory()
    try {
      val files = CastSampleFiles(directory, { stream() }, { Long.MAX_VALUE })
      assertEquals(CastSampleFiles.READY, files.prepare())
      assertEquals(CastSampleFiles.BYTES, File(directory, "sample-b.ts").length())
      assertFalse(File(directory, "sample-b.ts.part").exists())
      val other = File(directory, "unrelated").apply { writeText("keep") }
      files.cleanup()
      assertFalse(File(directory, "sample-b.ts").exists())
      assertEquals("keep", other.readText())
    } finally { directory.deleteRecursively() }
  }
  @Test fun insufficientStorageAndMidCopyFailureLeaveNoPublishedOrPartialFile() {
    val directory = directory()
    try {
      assertEquals(CastSampleFiles.NO_SPACE,
        CastSampleFiles(directory, { stream() }, { 0 }).prepare())
      var writes = 0
      val files = CastSampleFiles(directory, { stream() }, { Long.MAX_VALUE }, { file ->
        object : java.io.FilterOutputStream(file.outputStream()) {
          override fun write(bytes: ByteArray, offset: Int, length: Int) {
            if (++writes > 1) throw IOException("disk full during write")
            out.write(bytes, offset, length)
          }
        }
      })
      assertEquals(CastSampleFiles.COPY_FAILED, files.prepare())
      assertTrue(writes > 1)
      assertTrue(directory.listFiles()!!.isEmpty())
    } finally { directory.deleteRecursively() }
  }
  @Test fun missingAssetAndTruncatedAssetAreDistinctAndRemoveOldCopies() {
    val directory = directory()
    try {
      File(directory, "sample-b.ts").writeText("stale")
      File(directory, "sample-b.ts.part").writeText("interrupted")
      assertEquals(CastSampleFiles.NOT_INTEGRATED,
        CastSampleFiles(directory, { throw java.io.FileNotFoundException() }, { Long.MAX_VALUE }).prepare())
      assertEquals(CastSampleFiles.COPY_FAILED,
        CastSampleFiles(directory, { stream(123) }, { Long.MAX_VALUE }).prepare())
      assertTrue(directory.listFiles()!!.isEmpty())
    } finally { directory.deleteRecursively() }
  }
}

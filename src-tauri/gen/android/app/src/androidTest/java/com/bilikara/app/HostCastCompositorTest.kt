package com.bilikara.app

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer

/**
 * The composited cast's device pipeline: MediaCodec decode, GLES overlay and
 * MediaCodec H.264 encode, driven the way Rust drives it over JNI.
 *
 * Asset `compositor-source.mp4`: 320x180 blue, a white 40x40 box at (260,120),
 * 30 fps, 90 frames, H.264 Main, GOP 30 (FFmpeg lavfi + libx264, test-only).
 * The encoded streams are left in the app's external files directory as
 * `compositor-output.h264`, `compositor-hold.h264` and `compositor-blank.h264`
 * for an outside decoder to check the pixels.
 */
@RunWith(AndroidJUnit4::class)
class HostCastCompositorTest {
  private val width = 320
  private val height = 180

  private fun source(): File {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val file = File(instrumentation.targetContext.cacheDir, "compositor-source.mp4")
    instrumentation.context.assets.open("compositor-source.mp4").use { input ->
      file.outputStream().use { input.copyTo(it) }
    }
    return file
  }

  private class Unit(val flags: Int, val pts: Long, val dts: Long, val data: ByteArray)

  private fun next(id: Long, deadline: Long): Unit {
    while (System.nanoTime() < deadline) {
      val packed = HostCastCompositor.next(id, 200) ?: continue
      val buffer = ByteBuffer.wrap(packed)
      val flags = buffer.get().toInt()
      return Unit(flags, buffer.long, buffer.long, packed.copyOfRange(17, packed.size))
    }
    fail("compositor stalled")
    throw IllegalStateException()
  }

  private fun nal(data: ByteArray, type: Int): Boolean =
    (0 until data.size - 3).any {
      data[it].toInt() == 0 && data[it + 1].toInt() == 0 && data[it + 2].toInt() == 1 &&
        data[it + 3].toInt() and 0x1f == type
    }

  @Test fun decodesOverlaysAndEncodesOnSurfaces() {
    // Two seconds from the start of a three-second source at a 30 fps cap.
    val id = HostCastCompositor.open(
      source().path, HostCastCompositor.SOURCE_PLAY, 0, 2_000_000, width, height, 30, 1, 1_000_000)
    val overlay = ByteArray(width * height * 4)
    for (y in 10 until 50) for (x in 10 until 50) {
      val i = (y * width + x) * 4
      overlay[i] = 255.toByte()
      overlay[i + 3] = 255.toByte()
    }
    HostCastCompositor.setOverlay(id, overlay)
    val stream = ByteArrayOutputStream()
    val deadline = System.nanoTime() + 60_000_000_000
    var units = 0
    var keys = 0
    var last = Long.MIN_VALUE
    while (true) {
      val unit = next(id, deadline)
      if (unit.flags and 2 != 0) break
      val key = unit.flags and 1 != 0
      if (units == 0) assertTrue("first unit is a key frame", key)
      if (key) {
        keys++
        assertTrue("SPS before every key frame", nal(unit.data, 7))
        assertTrue("PPS before every key frame", nal(unit.data, 8))
      }
      assertTrue("increasing presentation times", unit.pts > last)
      assertEquals("no B-frames: decode time equals presentation time", unit.pts, unit.dts)
      assertTrue(unit.pts in 0 until 2_000_000)
      last = unit.pts
      stream.write(unit.data)
      units++
    }
    val encoder = HostCastCompositor.encoderName(id)
    HostCastCompositor.close(id)
    Log.i("HostCastCompositorTest", "encoder=$encoder units=$units keys=$keys last=$last")
    assertTrue("about 60 frames, got $units", units in 55..61)
    assertTrue("one-second GOP, got $keys keys", keys >= 2)
    val directory = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
    assertNotNull(directory)
    File(directory, "compositor-output.h264").writeBytes(stream.toByteArray())
  }

  /** Every unit until the end flag; checks the grid and parameter sets. */
  private fun drain(id: Long, name: String, expectedStart: Long, fps: Long): Int {
    val stream = ByteArrayOutputStream()
    val deadline = System.nanoTime() + 60_000_000_000
    var units = 0
    while (true) {
      val unit = next(id, deadline)
      if (unit.flags and 2 != 0) break
      if (units == 0) assertTrue("first unit is a key frame", unit.flags and 1 != 0)
      if (unit.flags and 1 != 0) assertTrue("SPS before every key frame", nal(unit.data, 7))
      assertEquals("frame grid", expectedStart + units * 1_000_000L / fps, unit.pts)
      stream.write(unit.data)
      units++
    }
    HostCastCompositor.close(id)
    val directory = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
    File(directory, name).writeBytes(stream.toByteArray())
    return units
  }

  @Test fun holdsAndBlanksOnTheFrameGrid() {
    // Pause: the first frame at or after 1.5 s (1.5 s exactly at 30 fps),
    // repeated for half a second on the 30 fps grid.
    val hold = HostCastCompositor.open(
      source().path, HostCastCompositor.SOURCE_HOLD, 1_500_000, 2_000_000, width, height, 30, 1, 1_000_000)
    assertEquals(15, drain(hold, "compositor-hold.h264", 1_500_000, 30))
    // A card: black with an opaque green overlay quarter, no source at all.
    val blank = HostCastCompositor.open(
      "", HostCastCompositor.SOURCE_BLANK, 0, 1_000_000, width, height, 25, 1, 500_000)
    val overlay = ByteArray(width * height * 4)
    for (y in 0 until height / 2) for (x in 0 until width / 2) {
      val i = (y * width + x) * 4
      overlay[i + 1] = 255.toByte()
      overlay[i + 3] = 255.toByte()
    }
    HostCastCompositor.setOverlay(blank, overlay)
    assertEquals(25, drain(blank, "compositor-blank.h264", 0, 25))
  }

  @Test fun frameRateCapAndCloseMidStream() {
    // A 15 fps cap keeps every other source frame.
    val id = HostCastCompositor.open(
      source().path, HostCastCompositor.SOURCE_PLAY, 1_000_000, 3_000_000, width, height, 15, 1, 500_000)
    val deadline = System.nanoTime() + 60_000_000_000
    val first = next(id, deadline)
    assertTrue(first.flags and 1 != 0)
    assertTrue("starts at the requested position", first.pts in 1_000_000 until 1_040_000)
    val second = next(id, deadline)
    assertTrue("15 fps spacing: ${second.pts - first.pts}", second.pts - first.pts in 60_000..70_000)
    HostCastCompositor.close(id)
    try {
      HostCastCompositor.next(id, 10)
      fail("a closed session refuses reads")
    } catch (expected: IllegalStateException) {
    }
  }
}

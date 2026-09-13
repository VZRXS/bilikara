package com.bilikara.app

import android.graphics.BitmapFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.zip.ZipFile

@RunWith(AndroidJUnit4::class)
class PlaylistExportInstrumentedTest {
  @Test fun imagesRenderUnicodeAndStreamEveryPageIncludingEmptyHistory() {
    val directory = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "export-regression").apply { mkdirs() }
    val row = ExportRow("【カラオケ】僕らのLIVE 君とのLIFE · 测试长标题", "BV1z84y1p7oS", "Kevin", "测试 UP", 42, 1, 1789210000.0, "https://www.bilibili.com/video/BV1z84y1p7oS", "", "P1")
    val single = File(directory, "unicode.png")
    single.outputStream().use { PlaylistExport(ExportRequest("x", "image", "played", 50), List(5) { row }).writeTo(it) }
    val image = BitmapFactory.decodeFile(single.path)
    assertEquals(720, image.width); assertEquals(570, image.height); image.recycle()
    val multi = File(directory, "pages.zip")
    multi.outputStream().use { PlaylistExport(ExportRequest("x", "image", "history", 50), List(61) { row }).writeTo(it) }
    ZipFile(multi).use { zip ->
      assertEquals(2, zip.size())
      for ((index, count) in listOf(50, 11).withIndex()) {
        val bitmap = zip.getInputStream(zip.getEntry("bilikara-page-${index + 1}.png")).use { BitmapFactory.decodeStream(it) }
        assertEquals(720, bitmap.width); assertEquals(180 + 78 * count, bitmap.height); bitmap.recycle()
      }
    }
    for (count in listOf(0, 200)) {
      val file = File(directory, "rows-$count.png")
      file.outputStream().use { PlaylistExport(ExportRequest("x", "image", "history", 200), List(count) { row }).writeTo(it) }
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(file.path, bounds)
      assertEquals(720, bounds.outWidth); assertEquals(180 + 78 * maxOf(1, count), bounds.outHeight)
    }
  }
}

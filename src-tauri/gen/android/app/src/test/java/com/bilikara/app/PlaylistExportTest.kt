package com.bilikara.app

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream

class PlaylistExportTest {
  @Test fun onlyBoundedHistoryExportsAreAccepted() {
    assertNotNull(ExportRequest.validated("export-1", "csv", "played", 200))
    assertNull(ExportRequest.validated("x", "csv", "../secret", 50))
    assertNull(ExportRequest.validated("x", "exe", "history", 50))
    assertNull(ExportRequest.validated("x", "image", "history", 100000))
    assertNull(ExportRequest.validated("x".repeat(65), "image", "history", 50))
  }

  @Test fun csvPreservesUtf8QuotesNewlinesAndPreventsFormulaExecution() {
    val row = ExportRow("=SUM(1,2)\n\"日本語\"", "BV1z84y1p7oS", "@user", "UP", 42, 3, 0.0, "https://bilibili.com", "", "P1")
    val export = PlaylistExport(ExportRequest("test", "csv", "played", 200), listOf(row))
    val output = ByteArrayOutputStream()
    export.writeTo(output)
    val csv = output.toString("UTF-8")
    assertTrue(csv.startsWith("\uFEFF\"序号\""))
    assertTrue(csv.contains("\"'=SUM(1,2)\n\"\"日本語\"\"\""))
    assertTrue(csv.contains("\"'@user\""))
    assertTrue(csv.endsWith("\r\n"))
    assertEquals("text/csv", export.mime)
    assertTrue(export.filename.endsWith(".csv"))
    assertEquals("image/png", PlaylistExport(ExportRequest("x", "image", "history", 50), emptyList()).mime)
    assertEquals("application/zip", PlaylistExport(ExportRequest("x", "image", "history", 50), List(51) { row }).mime)
  }
}

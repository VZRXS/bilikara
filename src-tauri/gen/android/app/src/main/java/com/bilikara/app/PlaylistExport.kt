package com.bilikara.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import java.io.OutputStream
import java.io.File
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

internal data class ExportRow(val title: String, val bvid: String, val requester: String, val owner: String,
  val ownerMid: Long, val count: Long, val at: Double, val url: String, val originalUrl: String, val part: String)

/** Rendering only: rows/order/counts come from Rust's immutable export snapshot. */
internal class PlaylistExport(private val request: ExportRequest, private val rows: List<ExportRow>) {
  private val pages = maxOf(1, (rows.size + request.pageSize - 1) / request.pageSize)
  val mime = if (request.format == "csv") "text/csv" else if (pages == 1) "image/png" else "application/zip"
  val filename = "bilikara-${request.source}-${SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date())}." +
    if (request.format == "csv") "csv" else if (pages == 1) "png" else "zip"

  fun writeTo(output: OutputStream) = synchronized(renderLock) {
    if (request.format == "csv") {
      output.write("\uFEFF".toByteArray(Charsets.UTF_8))
      writeCsvRow(output, listOf("序号", "标题", "BV 号", "点歌人", "UP 主", "UP 主 UID", "点歌次数", "播放时间", "视频链接", "原始链接", "分P/版本"))
      rows.forEachIndexed { index, row ->
        writeCsvRow(output, listOf((index + 1).toString(), row.title, row.bvid, row.requester, row.owner,
          row.ownerMid.takeIf { it > 0 }?.toString().orEmpty(), row.count.toString(), time(row.at), row.url, row.originalUrl, row.part))
      }
    } else if (pages == 1) {
      writePage(output, 0)
    } else {
      // Stream one bitmap at a time; never retain all rendered pages in memory.
      ZipOutputStream(output).use { zip ->
        repeat(pages) { page ->
          zip.putNextEntry(ZipEntry("bilikara-page-${page + 1}.png"))
          writePage(zip, page)
          zip.closeEntry()
        }
      }
    }
  }

  private fun writePage(output: OutputStream, page: Int) {
    val start = page * request.pageSize
    val entries = rows.subList(start, minOf(rows.size, start + request.pageSize))
    // Even 200 rows stay below 16384 pixels and ~45 MiB per ARGB bitmap.
    val bitmap = Bitmap.createBitmap(720, 180 + maxOf(1, entries.size) * 78, Bitmap.Config.ARGB_8888)
    try {
      val canvas = Canvas(bitmap)
      canvas.drawColor(Color.rgb(255, 250, 244))
      val ink = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(40, 35, 31); textSize = 15f }
      fun line(text: String, x: Float, y: Float, size: Float, bold: Boolean = false, width: Int = 624, lines: Int = 1) {
        ink.textSize = size
        ink.typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        val layout = StaticLayout.Builder.obtain(text, 0, text.length, ink, width)
          .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(false)
          .setMaxLines(lines).setEllipsize(TextUtils.TruncateAt.END).build()
        canvas.save(); canvas.translate(x, y); layout.draw(canvas); canvas.restore()
      }
      line("bilikara · ${when (request.source) { "played" -> "本场记录"; "history" -> "全部历史"; else -> "旧场次记录" }}", 32f, 26f, 30f, true)
      line("共 ${rows.size} 首   ·   第 ${page + 1} / $pages 页", 32f, 72f, 16f)
      if (entries.isEmpty()) line("暂无记录", 32f, 124f, 20f)
      entries.forEachIndexed { index, row ->
        val y = 114f + index * 78
        line("${start + index + 1}", 24f, y, 17f, true, 44)
        line(row.title, 72f, y, 18f, true, 616, 2)
        line(listOf(row.requester, row.owner, row.bvid, time(row.at)).filter { it.isNotEmpty() }.joinToString(" · "), 72f, y + 45, 12f, width = 616)
      }
      line("Bilikara Android · github.com/VZRXS/bilikara", 32f, bitmap.height - 36f, 13f)
      check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) { "PNG encoding failed" }
    } finally { bitmap.recycle() }
  }

  companion object {
    // Host SAF and Remote HTTP share the same renderer and bitmap memory budget.
    private val renderLock = Any()

    fun fromSnapshot(request: ExportRequest, data: JSONObject): PlaylistExport {
      require(data.getInt("schema_version") == 1 && data.getString("source") == request.source)
      val rows = data.getJSONArray("rows")
      require(rows.length() <= 10000)
      return PlaylistExport(request, (0 until rows.length()).map { index ->
        val row = rows.getJSONObject(index)
        ExportRow(row.getString("title"), row.getString("bvid"), row.getString("requester"),
          row.getString("owner"), row.getLong("owner_mid"), row.getLong("count"), row.getDouble("at"),
          row.getString("url"), row.getString("original_url"), row.getString("part"))
      })
    }

    /** Called only by Rust JNI, never exposed as a WebView message/JS interface. */
    fun renderRemote(spec: String, destination: String): Int = try {
      require(spec.length <= 17 * 1024 * 1024)
      val input = JSONObject(spec)
      val request = requireNotNull(ExportRequest.validated("remote", input.getString("format"),
        input.getString("source"), input.getInt("pageSize")))
      val target = File(destination)
      require(target.name.matches(Regex("remote-export-[A-Za-z0-9_-]{43}\\.tmp")))
      require(target.parentFile?.name == "remote-exports" && target.isFile && target.canonicalFile == target.absoluteFile)
      val document = fromSnapshot(request, input.getJSONObject("data"))
      target.outputStream().use { file ->
        document.writeTo(object : OutputStream() {
          private var count = 0L
          private fun reserve(size: Int) { count += size; require(count <= 64L * 1024 * 1024) { "Export too large" } }
          override fun write(value: Int) { reserve(1); file.write(value) }
          override fun write(bytes: ByteArray, offset: Int, length: Int) { reserve(length); file.write(bytes, offset, length) }
          override fun flush() = file.flush()
        })
      }
      0
    } catch (_: OutOfMemoryError) { 1 } catch (_: Exception) { 2 }

    internal fun csvCell(value: String): String {
      // Spreadsheet programs must not evaluate song titles / requester names.
      val safe = if (value.trimStart().firstOrNull() in listOf('=', '+', '-', '@') || value.startsWith('\t') || value.startsWith('\r')) "'$value" else value
      return "\"" + safe.replace("\"", "\"\"") + "\""
    }
    private fun writeCsvRow(output: OutputStream, values: List<String>) {
      output.write((values.joinToString(",", transform = ::csvCell) + "\r\n").toByteArray(Charsets.UTF_8))
    }
    private fun time(at: Double): String = if (at.isFinite() && at > 0)
      SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(Date((at * 1000).toLong())) else ""
  }
}

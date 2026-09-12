package com.bilikara.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** Origin-scoped save-only bridge. No arbitrary URL, path, bytes or native IPC. */
internal class HostExports(private val activity: AppCompatActivity) {
  private data class Pending(val request: ExportRequest, val reply: JavaScriptReplyProxy,
    var document: PlaylistExport? = null)
  private var pending: Pending? = null
  private var installed = false
  private val picker = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    val job = pending ?: return@registerForActivityResult
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      complete(job, "cancelled")
    } else if (uri.scheme != "content") {
      complete(job, "failed", "文件选择器未返回可写文档")
    } else {
      Thread({
        try {
          activity.contentResolver.openOutputStream(uri, "w")?.use { stream ->
            requireNotNull(job.document).writeTo(stream)
          } ?: error("No output stream")
          activity.runOnUiThread { complete(job, "saved") }
        } catch (_: OutOfMemoryError) {
          activity.runOnUiThread { complete(job, "failed", "导出图片内存不足，请减少每页歌曲数或改用 CSV") }
        } catch (_: Exception) {
          activity.runOnUiThread { complete(job, "failed", "无法保存导出文件，请检查剩余空间或重新选择位置") }
        }
      }, "bilikara-export-save").start()
    }
  }

  private fun complete(job: Pending, status: String, error: String = "") {
    if (pending !== job) return
    pending = null
    job.document = null
    reply(job.reply, job.request.id, status, error)
  }

  private fun reply(target: JavaScriptReplyProxy, id: String, status: String, error: String = "") {
    // A replaced/destroyed WebView may no longer have a receiver.
    try { target.postMessage(JSONObject().put("id", id).put("status", status)
      .put("errorMessage", error).toString()) } catch (_: Exception) { }
  }

  fun install(webView: WebView, origin: String): Boolean {
    if (installed) return true
    val expected = Uri.parse(origin)
    if (expected.scheme != "http" || expected.host != "127.0.0.1" || expected.port <= 0 ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
    WebViewCompat.addWebMessageListener(webView, "BilikaraHostExport", setOf(origin)) {
        _, message, sourceOrigin, isMainFrame, reply ->
      if (!isMainFrame || sourceOrigin != expected || message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
      val raw = message.data ?: return@addWebMessageListener
      if (raw.length > 2048) return@addWebMessageListener
      val input = try { JSONObject(raw) } catch (_: Exception) { return@addWebMessageListener }
      val id = input.optString("id")
      val request = ExportRequest.validated(id, input.optString("format"), input.optString("source"), input.optInt("pageSize"))
      if (request == null) {
        reply(reply, id.take(64), "failed", "无效的导出选项")
      } else if (pending != null) {
        reply(reply, id, "failed", "另一项导出尚未完成")
      } else {
        val job = Pending(request, reply)
        pending = job
        val cookie = CookieManager.getInstance().getCookie(origin).orEmpty()
        Thread({
          try {
            // Construct the sole allowed endpoint ourselves, with the Host's
            // HttpOnly session. No credentials ever cross the JS bridge.
            val connection = URL("$origin/api/playlist/export-data?source=${request.source}").openConnection() as HttpURLConnection
            val payload = try {
              connection.instanceFollowRedirects = false
              connection.connectTimeout = 5000
              connection.readTimeout = 30000
              connection.setRequestProperty("Cookie", cookie)
              connection.setRequestProperty("Origin", origin)
              require(connection.responseCode == 200) { "Export HTTP failure" }
              connection.inputStream.use { inputStream ->
                val bytes = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                  val count = inputStream.read(buffer)
                  if (count < 0) break
                  require(bytes.size() + count <= 17 * 1024 * 1024) { "Export too large" }
                  bytes.write(buffer, 0, count)
                }
                JSONObject(bytes.toString("UTF-8"))
              }
            } finally { connection.disconnect() }
            require(payload.optBoolean("ok"))
            val document = PlaylistExport.fromSnapshot(request, payload.getJSONObject("data"))
            activity.runOnUiThread {
              if (pending === job) {
                job.document = document
                try {
                  picker.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(document.mime).putExtra(Intent.EXTRA_TITLE, document.filename))
                } catch (_: Exception) { complete(job, "failed", "无法打开系统文件保存窗口") }
              }
            }
          } catch (_: Exception) {
            activity.runOnUiThread { complete(job, "failed", "无法读取导出记录，请返回 Host 后重试；记录过大时请选择本场记录") }
          }
        }, "bilikara-export-prepare").start()
      }
    }
    installed = true
    return true
  }
}

internal data class ExportRequest(val id: String, val format: String, val source: String, val pageSize: Int) {
  companion object {
    fun validated(id: String, format: String, source: String, pageSize: Int): ExportRequest? =
      if (id.matches(Regex("[A-Za-z0-9_-]{1,64}")) && format in listOf("csv", "image") &&
        source in listOf("played", "history") && pageSize in listOf(50, 60, 80, 100, 150, 200))
        ExportRequest(id, format, source, pageSize) else null
  }
}

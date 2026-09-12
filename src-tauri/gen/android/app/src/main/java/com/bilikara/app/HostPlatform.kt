package com.bilikara.app

import android.net.Uri
import android.os.Build
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/** Origin-scoped Android I/O only. Remote pages and subframes never get this bridge. */
internal class HostPlatform(private val activity: AppCompatActivity) {
  private var installed = false
  private val updater = HostUpdate(activity)

  fun install(webView: WebView, origin: String): Boolean {
    if (installed) return true
    val expected = Uri.parse(origin)
    if (expected.scheme != "http" || expected.host != "127.0.0.1" || expected.port <= 0 ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
    WebViewCompat.addWebMessageListener(webView, "BilikaraHostPlatform", setOf(origin)) {
        _, message, sourceOrigin, isMainFrame, reply ->
      if (!isMainFrame || sourceOrigin != expected || message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
      val raw = message.data ?: return@addWebMessageListener
      if (raw.length > 8192) return@addWebMessageListener
      val input = try { JSONObject(raw) } catch (_: Exception) { return@addWebMessageListener }
      val id = input.optString("id")
      if (!id.matches(Regex("[A-Za-z0-9_-]{1,64}"))) return@addWebMessageListener
      val result = JSONObject().put("id", id)
      if (input.optString("action") == "install-update") {
        updater.install(input.optJSONObject("package") ?: JSONObject()) { data, error ->
          if (error == null) result.put("ok", true).put("data", data)
          else result.put("ok", false).put("error", error)
          try { reply.postMessage(result.toString()) } catch (_: Exception) { }
        }
        return@addWebMessageListener
      }
      try {
        val data = when (input.optString("action")) {
          "environment" -> environment()
          else -> error("Unsupported platform action")
        }
        result.put("ok", true).put("data", data)
      } catch (_: Exception) {
        result.put("ok", false).put("error", "Android 系统操作失败，请确认有可用的浏览器或系统组件")
      }
      reply.postMessage(result.toString())
    }
    installed = true
    return true
  }

  private fun environment(): JSONObject {
    val webView = WebViewCompat.getCurrentWebViewPackage(activity)
    return JSONObject().put("release", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
      .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
      .put("version_name", BuildConfig.VERSION_NAME).put("version_code", BuildConfig.VERSION_CODE)
      .put("webview_package", webView?.packageName ?: "unknown")
      .put("webview_version", webView?.versionName ?: "unknown")
      .put("debug_build", BuildConfig.DEBUG)
  }

}

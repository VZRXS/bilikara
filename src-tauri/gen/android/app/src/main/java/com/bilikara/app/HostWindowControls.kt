package com.bilikara.app

import android.content.pm.ActivityInfo
import android.content.Context
import android.net.Uri
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebMessageCompat
import org.json.JSONObject

/** Window presentation only; no media or application-state authority. */
internal class HostWindowControls(private val activity: AppCompatActivity) {
  private var active = false
  private var previousOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
  private var installed = false
  // Device-local window preferences, not playlist/session/player state. Native
  // storage survives the loopback origin's port changing between launches.
  // MainActivity constructs this helper before ContextWrapper is attached.
  // Access storage only when install() runs with a live Activity context.
  private val preferences by lazy {
    HostWindowPreferences(activity.getSharedPreferences("host-window", Context.MODE_PRIVATE))
  }
  private val layoutModes = setOf("auto", "desktop", "phone")
  private val orientationModes = setOf("system", "landscape", "portrait")

  private fun requestedDirection(mode: String): Int = when (mode) {
    "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
    else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
  }

  private fun snapshot() = JSONObject(preferences.snapshot())

  fun install(webView: WebView, origin: String): Boolean {
    if (installed) return true
    val expected = Uri.parse(origin)
    if (expected.scheme != "http" || expected.host != "127.0.0.1" || expected.port <= 0 ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
    val back = object : OnBackPressedCallback(false) {
      override fun handleOnBackPressed() {
        setFullscreen(false)
        isEnabled = false
        webView.evaluateJavascript("document.exitFullscreen().catch(() => {})", null)
      }
    }
    activity.onBackPressedDispatcher.addCallback(activity, back)
    // The origin is passed by Rust from this process's listener, never by JS.
    // No wildcard origins, remote pages, subframes or generic native commands.
    WebViewCompat.addWebMessageListener(webView, "BilikaraHostWindow", setOf(origin)) {
        _, message, sourceOrigin, isMainFrame, reply ->
      if (isMainFrame && sourceOrigin == expected && message.type == WebMessageCompat.TYPE_STRING &&
        message.data in listOf("enter", "exit")) {
        val enabled = message.data == "enter"
        setFullscreen(enabled)
        back.isEnabled = enabled
        reply.postMessage(if (enabled) "entered" else "exited")
        return@addWebMessageListener
      }
      if (!isMainFrame || sourceOrigin != expected || message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
      val page = Uri.parse(webView.url ?: "")
      if (page.scheme != expected.scheme || page.authority != expected.authority ||
        page.path !in listOf("/", "/index.html")) return@addWebMessageListener
      val raw = message.data ?: return@addWebMessageListener
      if (raw.length > 1024) return@addWebMessageListener
      val input = try { JSONObject(raw) } catch (_: Exception) { return@addWebMessageListener }
      val id = input.optString("id")
      if (!id.matches(Regex("window-[0-9]{1,16}"))) return@addWebMessageListener
      val result = JSONObject().put("id", id)
      try {
        val mode = input.optString("mode")
        when (input.optString("action")) {
          "get-preferences" -> Unit
          "set-layout" -> {
            require(mode in layoutModes)
            preferences.setLayout(mode)
          }
          "set-orientation" -> {
            require(mode in orientationModes)
            preferences.setOrientation(mode)
            // Fullscreen temporarily overrides direction without overwriting
            // the user's preference. Some large-screen ROMs ignore requests.
            if (active) previousOrientation = requestedDirection(mode)
            else activity.requestedOrientation = requestedDirection(mode)
          }
          else -> error("unsupported_window_action")
        }
        result.put("ok", true).put("data", snapshot())
      } catch (error: Exception) {
        result.put("ok", false).put("error", if (error.message == "window_preferences_recovery_failed")
          "window_preferences_recovery_failed" else "window_preferences_failed")
      }
      reply.postMessage(result.toString())
    }
    activity.requestedOrientation = requestedDirection(snapshot().getString("orientation"))
    installed = true
    return true
  }

  internal fun setFullscreen(enabled: Boolean) {
    if (active == enabled) return
    active = enabled
    val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
    if (enabled) {
      previousOrientation = activity.requestedOrientation
      activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      activity.requestedOrientation = previousOrientation
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
  }
}

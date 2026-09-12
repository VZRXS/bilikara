package com.bilikara.app

import android.content.pm.ActivityInfo
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

/** Window presentation only; no media or application-state authority. */
internal class HostWindowControls(private val activity: AppCompatActivity) {
  private var active = false
  private var previousOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
  private var installed = false

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
      }
    }
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

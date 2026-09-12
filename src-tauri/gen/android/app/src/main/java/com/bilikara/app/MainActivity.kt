package com.bilikara.app

import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep

class MainActivity : TauriActivity() {
  private val hostWindowControls = HostWindowControls(this)

  @Keep
  fun installHostWindowControls(webView: WebView, origin: String): Boolean =
    hostWindowControls.install(webView, origin)

  // Same-document Host page history supports the system Back gesture.
  override val handleBackNavigation: Boolean = true

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    HostWindowInsets.install(findViewById(android.R.id.content))
    // Foreground HDMI mirror testing only; this is not a background wake lock.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }
}

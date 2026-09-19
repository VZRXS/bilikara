package com.bilikara.app

import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep

class MainActivity : TauriActivity() {
  companion object {
    @JvmStatic @Keep
    fun renderRemoteExport(spec: String, destination: String): Int = PlaylistExport.renderRemote(spec, destination)
  }
  private val hostWindowControls = HostWindowControls(this)
  private val hostExports = HostExports(this)
  private val hostPlatform = HostPlatform(this)
  private val hostPresentation by lazy { HostPresentation(this) }

  @Keep
  fun installHostWindowControls(webView: WebView, origin: String): Boolean {
    hostExports.install(webView, origin)
    hostPlatform.install(webView, origin)
    hostPresentation.install(webView, origin)
    return hostWindowControls.install(webView, origin)
  }

  // Same-document Host page history supports the system Back gesture.
  override val handleBackNavigation: Boolean = true

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    HostWindowInsets.install(findViewById(android.R.id.content))
    // Foreground playback and external presentation, not a background wake lock.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  override fun onResume() {
    super.onResume()
    hostPresentation.setForeground(true)
  }

  override fun onConfigurationChanged(configuration: android.content.res.Configuration) {
    super.onConfigurationChanged(configuration)
    hostPresentation.onControllerDisplayChanged()
  }

  override fun onPause() {
    hostPresentation.setForeground(false)
    super.onPause()
  }

  override fun onDestroy() {
    hostPresentation.destroy()
    super.onDestroy()
  }
}

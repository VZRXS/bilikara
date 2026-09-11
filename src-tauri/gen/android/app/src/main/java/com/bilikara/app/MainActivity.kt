package com.bilikara.app

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
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

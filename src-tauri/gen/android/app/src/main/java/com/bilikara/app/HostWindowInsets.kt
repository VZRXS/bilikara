package com.bilikara.app

import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Own system/keyboard insets once, outside both the bootstrap and Host WebViews. */
internal object HostWindowInsets {
  fun install(content: View) {
    val handled = WindowInsetsCompat.Type.systemBars() or
      WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      // getInsets unions the types: IME and navigation bar must not be added.
      val safe = windowInsets.getInsets(handled)
      view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      // Let unhandled insets propagate. Returning CONSUMED can leave stale
      // CSS safe-area values in newer WebViews after rotation/keyboard changes.
      WindowInsetsCompat.Builder(windowInsets)
        .setInsets(handled, Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(content)
  }
}

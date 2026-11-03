package com.bilikara.app

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Own system/keyboard insets once, outside both the bootstrap and Host WebViews. */
internal object HostWindowInsets {
  fun install(content: View) {
    val safeTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    val handled = safeTypes or WindowInsetsCompat.Type.ime()
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      // IME overlays the fixed native window. Only content and transient
      // messages avoid it; the bottom navigation retains its physical position.
      val safe = windowInsets.getInsets(safeTypes)
      view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      val keyboard = (windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom - safe.bottom).coerceAtLeast(0)
      publishKeyboard(view, keyboard)
      // Let unhandled insets propagate. Returning CONSUMED can leave stale
      // CSS safe-area values in newer WebViews after rotation/keyboard changes.
      WindowInsetsCompat.Builder(windowInsets)
        .setInsets(handled, Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(content)
  }

  private fun publishKeyboard(view: View, bottom: Int) {
    if (view is WebView) {
      view.evaluateJavascript("window.dispatchEvent(new CustomEvent('bilikara:ime',{detail:{bottom:$bottom}}))", null)
    } else if (view is ViewGroup) {
      for (index in 0 until view.childCount) publishKeyboard(view.getChildAt(index), bottom)
    }
  }
}

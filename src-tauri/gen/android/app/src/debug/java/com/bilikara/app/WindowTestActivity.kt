package com.bilikara.app

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/** Instrumentation-only window, without the process-owning Rust Host. */
class WindowTestActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar)
    super.onCreate(savedInstanceState)
  }
}

package com.bilikara.app

import android.content.pm.ActivityInfo
import android.content.Intent
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostWindowControlsTest {
  @Test fun fullscreenRestoresOriginalOrientationAndRejectsForeignOrigins() {
    // Exercise the Android window adapter without launching the Rust/WebView
    // bootstrap concurrently with instrumented Activity lifecycle changes.
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    ActivityScenario.launch<WindowTestActivity>(Intent(context, WindowTestActivity::class.java)).use { scenario ->
      scenario.onActivity { activity ->
        val controls = HostWindowControls(activity)
        val view = WebView(activity)
        for (origin in listOf("https://example.com", "http://192.168.1.2:8000", "http://127.0.0.1")) {
          assertFalse(controls.install(view, origin))
        }
        val original = activity.requestedOrientation
        controls.setFullscreen(true)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, activity.requestedOrientation)
        controls.setFullscreen(true)
        controls.setFullscreen(false)
        assertEquals(original, activity.requestedOrientation)
        controls.setFullscreen(false)
        assertEquals(original, activity.requestedOrientation)
        view.destroy()
      }
    }
  }
}

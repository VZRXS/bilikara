package com.bilikara.app

import android.widget.FrameLayout
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostWindowInsetsTest {
  @Test fun rotationAndKeyboardReplaceInsetsWithoutAccumulation() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val content = FrameLayout(instrumentation.targetContext)
      HostWindowInsets.install(content)
      fun dispatch(bars: Insets, cutout: Insets, ime: Insets) {
        val input = WindowInsetsCompat.Builder()
          .setInsets(WindowInsetsCompat.Type.systemBars(), bars)
          .setInsets(WindowInsetsCompat.Type.displayCutout(), cutout)
          .setInsets(WindowInsetsCompat.Type.ime(), ime)
          .setInsets(WindowInsetsCompat.Type.systemGestures(), Insets.of(8, 0, 8, 16))
          .build()
        val child = ViewCompat.dispatchApplyWindowInsets(content, input)
        val expected = input.getInsets(WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
        assertEquals(expected, Insets.of(content.paddingLeft, content.paddingTop,
          content.paddingRight, content.paddingBottom))
        assertEquals(Insets.NONE, child.getInsets(WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()))
        assertEquals(Insets.of(8, 0, 8, 16), child.getInsets(WindowInsetsCompat.Type.systemGestures()))
      }
      repeat(2) { dispatch(Insets.of(0, 24, 0, 24), Insets.of(0, 48, 0, 0), Insets.NONE) }
      dispatch(Insets.of(0, 24, 0, 24), Insets.of(0, 48, 0, 0), Insets.of(0, 0, 0, 300))
      dispatch(Insets.of(0, 24, 0, 24), Insets.of(0, 48, 0, 0), Insets.NONE)
      dispatch(Insets.of(0, 0, 24, 0), Insets.of(48, 0, 0, 0), Insets.NONE)
      dispatch(Insets.NONE, Insets.NONE, Insets.NONE)
    }
  }
}

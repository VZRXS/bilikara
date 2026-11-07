package com.bilikara.app

import android.content.ComponentName
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostMediaPlaybackTest {
  private fun waitFor(read: () -> Boolean) {
    val deadline = SystemClock.elapsedRealtime() + 5000
    while (!read() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(20)
    assertTrue(read())
  }
  @Test fun serviceIsPrivateAndForegroundPolicyLocksAndStopAreRealAndroidResources() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val info = context.packageManager.getServiceInfo(ComponentName(context, HostMediaPlaybackService::class.java), 0)
    assertFalse(info.exported)
    if (Build.VERSION.SDK_INT >= 29) assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK, info.foregroundServiceType)
    HostMediaPlayback.foreground = false
    assertEquals(2, HostMediaPlayback.update(context, 2))
    ActivityScenario.launch<WindowTestActivity>(Intent(context, WindowTestActivity::class.java)).use { scenario ->
      try {
        scenario.onActivity { HostMediaPlayback.foreground = true; assertEquals(0, HostMediaPlayback.update(context, 2)) }
        waitFor { HostMediaPlayback.service?.heldLocks() == listOf(true, true, true) }
        val active = HostMediaPlayback.service
        assertEquals(0, HostMediaPlayback.update(context, 1))
        waitFor { active?.heldLocks() == listOf(false, false, false) }
        assertSame(active, HostMediaPlayback.service)
        // Existing foreground media service can resume while its Activity is backgrounded.
        HostMediaPlayback.foreground = false
        assertEquals(0, HostMediaPlayback.update(context, 2))
        waitFor { active?.heldLocks() == listOf(true, true, true) }
        assertEquals(0, HostMediaPlayback.update(context, 0))
        waitFor { HostMediaPlayback.service == null }
        assertEquals(listOf(false, false, false), active?.heldLocks())
      } finally {
        HostMediaPlayback.foreground = false
        HostMediaPlayback.update(context, 0)
      }
    }
  }
}

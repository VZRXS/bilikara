package com.bilikara.app

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostRoomAuthorizationTest {
  @Test fun officialLinkIsDispatchedOnlyToWeChatAndInvalidLinksNeverLeaveHost() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    ActivityScenario.launch<WindowTestActivity>(Intent(context, WindowTestActivity::class.java)).use { scenario ->
      val intents = mutableListOf<Intent>()
      val monitor = object : Instrumentation.ActivityMonitor() {
        override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
          intents.add(Intent(intent))
          // Intercept the real system dispatch without installing/impersonating
          // WeChat, contacting an authorization server or opening a browser.
          return Instrumentation.ActivityResult(Activity.RESULT_OK, null)
        }
      }
      instrumentation.addMonitor(monitor)
      try {
        scenario.onActivity { activity ->
          val authorization = HostRoomAuthorization(activity)
          val url = "https://wx.chunk.cn/projection/login?place_code=synthetic&projection_url=fixture"
          val result = authorization.open(url)
          assertTrue(result.getBoolean("opened"))
          assertEquals("wechat-link", result.getString("mode"))
          assertEquals(1, intents.size)
          assertEquals("com.tencent.mm", intents.single().`package`)
          assertEquals(Intent.ACTION_VIEW, intents.single().action)
          assertEquals(url, intents.single().dataString)
          for (invalid in listOf("https://example.invalid/", "weixin://arbitrary", "https://wx.chunk.cn.evil.invalid/projection/login?x=1")) {
            try { authorization.open(invalid); fail("Invalid URL must be rejected") }
            catch (_: IllegalStateException) { }
          }
          assertEquals("Invalid URLs must not reach any app", 1, intents.size)
        }
      } finally {
        instrumentation.removeMonitor(monitor)
      }
    }
  }
}

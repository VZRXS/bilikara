package com.bilikara.app

import android.content.Intent
import android.util.Log
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.assertion.ViewAssertions.doesNotExist
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class HostWebViewDiagnosticsTest {
  @Test fun adviceExplainsCompatibilityWithoutAskingForAnUpdate() {
    val passed = HostWebViewDiagnostics.statusMessage(113, true, 0)
    assertTrue(passed.contains("可以关闭此窗口继续使用"))
    assertFalse(passed.contains("请更新"))
    assertTrue(HostWebViewDiagnostics.statusMessage(101, true, 4).contains("暂不兼容"))
    assertFalse(HostWebViewDiagnostics.statusMessage(101, true, 4).contains("请更新"))
    assertTrue(HostWebViewDiagnostics.statusMessage(113, false, 0).contains("暂不兼容"))
    val incomplete = HostWebViewDiagnostics.statusMessage(113, true, null)
    assertTrue(incomplete.contains("未能完成"))
    assertFalse(incomplete.contains("请更新"))
    assertTrue(HostWebViewDiagnostics.statusMessage(null, true, 0).contains("未能确认"))
  }

  @Test fun legacyRequiresVerifiedBaselineBridgeAndStartupEntry() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    ActivityScenario.launch<WindowTestActivity>(Intent(context, WindowTestActivity::class.java)).use { scenario ->
      scenario.onActivity { activity ->
        val diagnostics = HostWebViewDiagnostics(activity)
        val facts = JSONObject().put("legacy_entry", true).put("legacy_missing", org.json.JSONArray())
        assertTrue(diagnostics.canEnterLegacy(91, true, facts))
        assertTrue(diagnostics.canEnterLegacy(83, true, facts))
        assertFalse(diagnostics.canEnterLegacy(82, true, facts))
        assertFalse(diagnostics.canEnterLegacy(null, true, facts))
        assertFalse(diagnostics.canEnterLegacy(91, false, facts))
        assertFalse(diagnostics.canEnterLegacy(91, true, null))
        facts.put("legacy_entry", false)
        assertFalse(diagnostics.canEnterLegacy(91, true, facts))
        facts.put("legacy_entry", true).put("legacy_missing", org.json.JSONArray().put("Web Crypto"))
        assertFalse(diagnostics.canEnterLegacy(91, true, facts))
      }
    }
  }

  // Use the standard Espresso device setup (system animations off).
  @Test fun reportCanBeCopiedAndClosedWithoutAnyUpdateAction() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val provider = WebViewCompat.getCurrentWebViewPackage(context)!!
    val reportReady = CountDownLatch(1)
    ActivityScenario.launch<WindowTestActivity>(Intent(context, WindowTestActivity::class.java)).use { scenario ->
      lateinit var diagnostics: HostWebViewDiagnostics
      lateinit var webView: WebView
      lateinit var clipboard: android.content.ClipboardManager
      var previousClip: android.content.ClipData? = null
      scenario.onActivity { activity ->
        clipboard = activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        previousClip = clipboard.primaryClip
        webView = WebView(activity)
        webView.settings.javaScriptEnabled = true
        activity.setContentView(webView)
        diagnostics = HostWebViewDiagnostics(activity)
        diagnostics.show(webView)
        webView.evaluateJavascript("true") { reportReady.countDown() }
      }
      try {
        assertTrue("Native diagnostic report settled", reportReady.await(5, TimeUnit.SECONDS))
        instrumentation.waitForIdleSync()
        onView(withText("WebView 兼容性自检")).check(matches(isDisplayed()))
        onView(withText("检查更新")).check(doesNotExist())
        onView(withId(android.R.id.message)).check { view, error ->
          if (error != null) throw error
          val message = (view as android.widget.TextView).text.toString()
          assertTrue(message.contains(provider.packageName))
          assertTrue(message.contains(provider.versionName!!))
          assertFalse("No instruction to update the component", message.contains("请更新"))
          if (provider.versionName!!.substringBefore('.').toInt() >= HostWebViewDiagnostics.UI_CHROMIUM_BASELINE)
            assertTrue("Supported engine must not look blocked", message.contains("可以关闭此窗口继续使用"))
        }
        onView(withText("复制诊断")).perform(click())
        scenario.onActivity {
          val copied = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString() ?: ""
          assertTrue("Actual clipboard includes active provider", copied.contains(provider.packageName))
          assertTrue("Actual clipboard includes full version", copied.contains(provider.versionName!!))
        }
        onView(withText("关闭")).perform(click())
        onView(withText("WebView 兼容性自检")).check(doesNotExist())
      } finally {
        scenario.onActivity {
          diagnostics.destroy(); webView.destroy()
          previousClip?.let { clipboard.setPrimaryClip(it) } ?: run {
            if (android.os.Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip()
            else clipboard.setPrimaryClip(android.content.ClipData.newPlainText("", ""))
          }
        }
      }
    }
  }

  @Test fun diagnosticProbeRunsOnActualLoadedWebViewAndRecordsMissingCapabilities() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    ActivityScenario.launch<WindowTestActivity>(Intent(context, WindowTestActivity::class.java)).use { scenario ->
      lateinit var view: WebView
      val loaded = CountDownLatch(1)
      scenario.onActivity { activity ->
        view = WebView(activity)
        view.settings.javaScriptEnabled = true
        activity.setContentView(view)
        view.webViewClient = object : WebViewClient() {
          override fun onPageFinished(view: WebView, url: String) { loaded.countDown() }
        }
        view.loadDataWithBaseURL("http://127.0.0.1/", "<!doctype html><title>Local WebView probe</title>", "text/html", "UTF-8", null)
      }
      assertTrue(loaded.await(10, TimeUnit.SECONDS))
      val received = CountDownLatch(1)
      var report: JSONObject? = null
      scenario.onActivity {
        view.evaluateJavascript(HostWebViewDiagnostics.PROBE) { value ->
          report = JSONObject(JSONTokener(value).nextValue() as String)
          received.countDown()
        }
      }
      assertTrue(received.await(10, TimeUnit.SECONDS))
      val provider = WebViewCompat.getCurrentWebViewPackage(context)!!
      assertTrue(report!!.getString("user_agent").contains("Chrome/${provider.versionName}"))
      val missing = report!!.getJSONArray("missing")
      if (provider.versionName!!.substringBefore('.').toInt() >= HostWebViewDiagnostics.UI_CHROMIUM_BASELINE)
        assertEquals("Current complete UI capability baseline", 0, missing.length())
      else assertTrue("Historic engine must expose actual missing capabilities", missing.length() > 0)
      Log.i("BilikaraWebViewTest", JSONObject().put("package", provider.packageName)
        .put("version", provider.versionName).put("facts", report).toString())
      scenario.onActivity { view.destroy() }
    }
  }
}

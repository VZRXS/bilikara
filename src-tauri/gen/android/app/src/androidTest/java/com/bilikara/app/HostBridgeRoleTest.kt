package com.bilikara.app

import android.content.Intent
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

@RunWith(AndroidJUnit4::class)
class HostBridgeRoleTest {
  @Test fun sameOriginRemoteAndAudienceCannotUseHostWindowOrPlatformBridges() {
    // A real WebView/message listener regression, with an isolated HTTP page.
    // This fixture does not start or impersonate the Rust application service.
    val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    val origin = "http://127.0.0.1:${server.localPort}"
    val worker = thread(isDaemon = true) {
      while (!server.isClosed) {
        try {
          server.accept().use { socket ->
            socket.soTimeout = 5000
            val reader = socket.getInputStream().bufferedReader()
            while (!reader.readLine().isNullOrEmpty()) { }
            val body = "<!doctype html><title>Bridge role fixture</title>".toByteArray()
            socket.getOutputStream().apply {
              write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
              write(body)
              flush()
            }
          }
        } catch (error: Exception) {
          if (!server.isClosed) throw error
        }
      }
    }
    try {
      val context = InstrumentationRegistry.getInstrumentation().targetContext
      ActivityScenario.launch<WindowTestActivity>(Intent(context, WindowTestActivity::class.java)).use { scenario ->
        lateinit var view: WebView
        lateinit var controls: HostWindowControls
        scenario.onActivity { activity ->
          view = WebView(activity)
          view.settings.javaScriptEnabled = true
          activity.setContentView(view)
          controls = HostWindowControls(activity)
          assertTrue(controls.install(view, origin))
          assertTrue(HostPlatform(activity).install(view, origin))
        }
        try {
          for (path in listOf("/", "/remote", "/remote.html", "/controller.html", "/audience", "/index.html")) {
            val loaded = CountDownLatch(1)
            scenario.onActivity {
              view.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) { loaded.countDown() }
              }
              view.loadUrl(origin + path)
            }
            assertTrue("Page loaded: $path", loaded.await(10, TimeUnit.SECONDS))
            val received = CountDownLatch(1)
            var result = ""
            var orientation = 0
            scenario.onActivity { activity ->
              orientation = activity.requestedOrientation
              view.evaluateJavascript("""
                window.bridgeReplies = {sent: true};
                BilikaraHostWindow.onmessage = e => bridgeReplies.window = e.data;
                BilikaraHostPlatform.onmessage = e => bridgeReplies.platform = JSON.parse(e.data).ok;
                BilikaraHostWindow.postMessage('enter');
                BilikaraHostPlatform.postMessage(JSON.stringify({id:'role-test',action:'environment'}));
              """.trimIndent(), null)
              view.postDelayed({
                view.evaluateJavascript("JSON.stringify(bridgeReplies)") { value ->
                  result = value
                  received.countDown()
                }
              }, 800)
            }
            assertTrue("Bridge result: $path", received.await(5, TimeUnit.SECONDS))
            val replies = JSONObject(org.json.JSONTokener(result).nextValue() as String)
            assertTrue(replies.getBoolean("sent"))
            if (path in listOf("/", "/index.html")) {
              assertEquals("entered", replies.getString("window"))
              assertTrue(replies.getBoolean("platform"))
            } else {
              assertFalse("Window authority on $path", replies.has("window"))
              assertFalse("Platform authority on $path", replies.has("platform"))
              scenario.onActivity { assertEquals(orientation, it.requestedOrientation) }
            }
            scenario.onActivity { controls.setFullscreen(false) }
          }
        } finally {
          scenario.onActivity { controls.setFullscreen(false); view.destroy() }
        }
      }
    } finally {
      server.close()
      worker.join(2000)
    }
  }
}

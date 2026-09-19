package com.bilikara.app

import android.annotation.SuppressLint
import android.app.Presentation
import android.content.Context
import android.graphics.Color
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Display
import android.view.Gravity
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/** Android window lifecycle / message transport only. The shared Host remains
 * the sole playback authority; there is no playlist, audio or cache state here. */
internal class HostPresentation(private val activity: AppCompatActivity) : DisplayManager.DisplayListener {
  private val manager = activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
  private val handler = Handler(Looper.getMainLooper())
  private var host: WebView? = null
  private var origin = ""
  private var output: WebView? = null
  private var presentation: Presentation? = null
  private val identifiers = mutableListOf<Presentation>()
  private var generation = 0L
  private var phase = "inactive"
  private var displayId = -1
  private var hostReady = false
  private var outputReady = false
  private var foreground = true
  private var reason = ""
  private var master: JSONObject? = null
  private var lastMasterAt = 0L
  private var telemetry = JSONObject()
  private val events = ArrayDeque<JSONObject>()

  fun install(view: WebView, hostOrigin: String): Boolean {
    if (host != null) return true
    val uri = Uri.parse(hostOrigin)
    if (uri.scheme != "http" || uri.host != "127.0.0.1" || uri.port <= 0 ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
    origin = hostOrigin
    host = view
    installBridge(view, false, 0)
    manager.registerDisplayListener(this, handler)
    record("installed")
    return true
  }

  private fun installBridge(view: WebView, stage: Boolean, windowGeneration: Long) {
    val expected = Uri.parse(origin)
    WebViewCompat.addWebMessageListener(view, "BilikaraHostPresentation", setOf(origin)) {
        _, message, sourceOrigin, isMainFrame, reply ->
      if (!isMainFrame || sourceOrigin != expected || message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
      if (stage && (view !== output || generation != windowGeneration)) return@addWebMessageListener
      val page = Uri.parse(view.url ?: "")
      if (page.scheme != expected.scheme || page.authority != expected.authority ||
        page.path !in (if (stage) listOf("/controller.html") else listOf("/", "/index.html"))) return@addWebMessageListener
      val raw = message.data ?: return@addWebMessageListener
      if (raw.length > 1_048_576) return@addWebMessageListener
      val request = try { JSONObject(raw) } catch (_: Exception) { return@addWebMessageListener }
      val command = request.optString("command")
      val args = request.optJSONObject("args") ?: JSONObject()
      if (!stage && command == "master-state") {
        if (phase !in listOf("activating", "active") ||
          args.optString("type") != "master-state" || args.optInt("protocol") != 1 ||
          args.optJSONObject("payload")?.optJSONObject("scene")?.optLong("generation", -1) != generation) return@addWebMessageListener
        master = args
        lastMasterAt = SystemClock.uptimeMillis()
        if (foreground && outputReady) emit(output, "master-state", args)
        return@addWebMessageListener
      }
      if (stage && command == "output-diagnostics") {
        // Fixed numeric/boolean fields only; never URLs, titles or credentials.
        telemetry = JSONObject()
        for (key in listOf("drift_ms", "current_time", "ready_state", "dropped_frames", "total_frames", "error_code")) {
          val value = args.optDouble(key, Double.NaN)
          if (value.isFinite()) telemetry.put(key, value)
        }
        for (key in listOf("paused", "seeking", "stale")) telemetry.put(key, args.optBoolean(key))
        emit(host, "output-diagnostics", telemetry)
        if (telemetry.optInt("error_code") > 0) stop("outputMediaFailed")
        return@addWebMessageListener
      }
      val id = request.optString("id")
      if (!id.matches(Regex("[A-Za-z0-9_-]{1,64}"))) return@addWebMessageListener
      val response = JSONObject().put("id", id)
      try {
        val common = setOf("get_presentation_session", "deactivate_local_presentation")
        val allowed = if (stage) common + "mark_presentation_controller_ready" else common + setOf(
          "get_presentation_displays", "activate_local_presentation", "mark_presentation_host_ready",
          "publish_presentation_playback_state", "show_presentation_display_identifiers",
          "dismiss_presentation_display_identifiers", "diagnostics")
        require(command in allowed) { "unsupported_command" }
        val data: Any = when (command) {
          "get_presentation_displays" -> displays()
          "get_presentation_session" -> session()
          "activate_local_presentation" -> activate(args.getString("displayId"))
          "deactivate_local_presentation" -> {
            require(args.optLong("generation", -1) == generation) { "stale_generation" }
            stop("userStopped")
            session()
          }
          "mark_presentation_host_ready", "mark_presentation_controller_ready" -> {
            require(args.optLong("generation", -1) == generation && phase in listOf("activating", "active")) { "stale_generation" }
            if (stage) outputReady = true else {
              require(args.optString("composition") == "stageOnly") { "invalid_composition" }
              hostReady = true
            }
            if (hostReady && outputReady && phase == "activating") {
              phase = "active"
              record("active")
              notifySession()
            }
            if (stage && foreground) master?.let { emit(output, "master-state", it) }
            session()
          }
          "publish_presentation_playback_state" -> {
            require(args.optLong("generation", -1) == generation) { "stale_generation" }
            // Desktop shell uses this projection; Android's stage receives the
            // existing master envelope, not a second playback state machine.
            JSONObject.NULL
          }
          "show_presentation_display_identifiers" -> { identify(); JSONObject.NULL }
          "dismiss_presentation_display_identifiers" -> { dismissIdentifiers(); JSONObject.NULL }
          else -> diagnostics()
        }
        response.put("ok", true).put("data", data)
      } catch (error: Exception) {
        val code = error.message?.takeIf { it.matches(Regex("[a-z_]{1,64}")) } ?: "display_operation_failed"
        record(code)
        response.put("ok", false).put("error", code)
      }
      try { reply.postMessage(response.toString()) } catch (_: Exception) { }
    }
  }

  private fun session() = JSONObject().put("mode", if (phase == "inactive") "singleScreen" else "localDualScreen")
    .put("phase", phase).put("generation", generation).put("hostReady", hostReady).put("controllerReady", outputReady)
    .put("selectedOutputDisplayId", if (displayId < 0) "" else displayId.toString())
    .put("controllerDisplayId", controllerDisplayId()?.toString() ?: "")
    .put("lastAcceptedCommandSequence", 0).put("lastAppliedCommandSequence", 0)
    .put("playbackAuthority", "host").put("mediaRendererOwner", "host").put("recoveryReason", reason)

  // This is the Activity's display, not necessarily the system display 0.
  // WindowManager's context-associated display also works on API 24-29.
  @Suppress("DEPRECATION")
  private fun controllerDisplayId(): Int? = activity.windowManager.defaultDisplay
    ?.takeIf { it.isValid }?.displayId

  private fun targets(controllerId: Int? = controllerDisplayId()) =
    manager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION)
      .filter { it.isValid && isAudienceDisplay(it.displayId, controllerId) }

  private fun displays(): JSONObject {
    val controllerId = controllerDisplayId()
    val candidates = targets(controllerId)
    val selectable = candidates.map { it.displayId }.toSet()
    val list = JSONArray()
    for (display in manager.displays.filter { it.isValid }) {
      val mode = display.mode
      val metrics = android.util.DisplayMetrics()
      @Suppress("DEPRECATION")
      display.getMetrics(metrics)
      list.put(JSONObject().put("id", display.displayId.toString()).put("name", display.name)
        .put("width", mode.physicalWidth).put("height", mode.physicalHeight)
        .put("refreshRate", mode.refreshRate).put("scaleFactor", metrics.density)
        .put("flags", display.flags).put("state", display.state)
        .put("builtIn", display.displayId == Display.DEFAULT_DISPLAY)
        .put("controller", display.displayId == controllerId)
        .put("primary", display.displayId == Display.DEFAULT_DISPLAY)
        .put("selectable", display.displayId in selectable)
        // IDs are valid for this attachment only and are never persisted.
        .put("identityStable", true).put("identityQuality", "stable").put("mirrored", false))
    }
    return JSONObject().put("displays", list).put("monitorCount", list.length())
      .put("controllerDisplayId", controllerId?.toString() ?: "")
      .put("recommendedDisplayId", candidates.firstOrNull()?.displayId?.toString() ?: "")
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun activate(id: String): JSONObject {
    require(phase == "inactive" && foreground) { "display_busy" }
    val target = targets().firstOrNull { it.displayId.toString() == id } ?: error("display_unavailable")
    dismissIdentifiers()
    generation++
    val lease = generation
    phase = "activating"
    displayId = target.displayId
    hostReady = false
    outputReady = false
    reason = ""
    master = null
    lastMasterAt = SystemClock.uptimeMillis()
    telemetry = JSONObject()
    try {
      val dialog = Presentation(activity, target, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
      val view = WebView(dialog.context)
      output = view
      presentation = dialog
      view.setBackgroundColor(Color.BLACK)
      view.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        mediaPlaybackRequiresUserGesture = false // Muted video only; Host owns audio.
        allowFileAccess = false
        allowContentAccess = false
        setSupportMultipleWindows(false)
      }
      installBridge(view, true, lease)
      val url = "$origin/controller.html?presentationGeneration=$lease"
      view.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.toString() != url
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
          if (request.isForMainFrame && output === view) stop("outputLoadFailed")
        }
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
          if (output === view) stop("outputRendererGone")
          return true
        }
      }
      dialog.setContentView(view)
      dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
        WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
      dialog.setOnDismissListener { if (presentation === dialog) stop("displayDisconnected") }
      dialog.show()
      dialog.window?.let { WindowCompat.getInsetsController(it, it.decorView).hide(WindowInsetsCompat.Type.systemBars()) }
      view.loadUrl(url)
      record("activating")
      watchHost(lease)
      handler.postDelayed({ if (generation == lease && phase == "activating") stop("outputTimeout") }, 15000)
      return session()
    } catch (_: Exception) {
      stop("outputCreateFailed")
      error("display_create_failed")
    }
  }

  private fun stop(why: String) {
    val oldView = output
    val oldDialog = presentation
    output = null
    presentation = null
    phase = "inactive"
    displayId = -1
    hostReady = false
    outputReady = false
    master = null
    reason = why
    oldDialog?.setOnDismissListener(null)
    oldDialog?.dismiss()
    oldView?.stopLoading()
    oldView?.destroy()
    record(why)
    notifySession()
  }

  private fun watchHost(lease: Long) {
    handler.postDelayed({
      if (generation == lease && phase != "inactive") {
        // Moving an Activity need not add/remove/change a physical display.
        // Recheck its association even if a same-size move sends no config event.
        if (!isAudienceDisplay(displayId, controllerDisplayId())) {
          stop("displayDisconnected")
        } else if (foreground && phase == "active" && SystemClock.uptimeMillis() - lastMasterAt > 5000) {
          stop("outputHeartbeatLost")
        } else watchHost(lease)
      }
    }, 1000)
  }

  private fun emit(view: WebView?, name: String, payload: JSONObject) {
    if (view == null) return
    val data = JSONObject().put("name", name).put("payload", payload)
    view.evaluateJavascript("window.dispatchEvent(new CustomEvent('bilikara-native-presentation',{detail:JSON.parse(${JSONObject.quote(data.toString())})}))", null)
  }

  private fun notifySession() {
    val payload = JSONObject().put("session", session())
    emit(host, "bilikara-presentation-state", payload)
    emit(output, "bilikara-presentation-state", payload)
  }

  fun setForeground(value: Boolean) {
    foreground = value
    if (value) changed()
    if (value) lastMasterAt = SystemClock.uptimeMillis()
    val payload = JSONObject().put("foreground", value)
    emit(host, "foreground", payload)
    emit(output, "foreground", payload)
    if (value) output?.onResume() else { output?.onPause(); dismissIdentifiers() }
    record(if (value) "foreground" else "background")
  }

  override fun onDisplayAdded(id: Int) = changed()
  override fun onDisplayChanged(id: Int) = changed()
  override fun onDisplayRemoved(id: Int) = changed()
  fun onControllerDisplayChanged() { dismissIdentifiers(); changed(); notifySession() }
  private fun changed() {
    if (phase != "inactive" && targets().none { it.displayId == displayId }) stop("displayDisconnected")
    record("displaysChanged")
    emit(host, "displays-changed", displays())
  }

  private fun identify() {
    require(phase == "inactive" && foreground) { "display_busy" }
    dismissIdentifiers()
    val allIds = manager.displays.filter { it.isValid }.map { it.displayId }
    for (target in targets()) {
      val dialog = Presentation(activity, target, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
      dialog.setContentView(TextView(dialog.context).apply {
        text = "bilikara\n${allIds.indexOf(target.displayId) + 1}\n${target.mode.physicalWidth} × ${target.mode.physicalHeight}"
        textSize = 48f
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.BLACK)
      })
      dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
      try { dialog.show(); identifiers.add(dialog) } catch (_: WindowManager.InvalidDisplayException) { }
    }
    val current = identifiers.toList()
    handler.postDelayed({ current.forEach { it.dismiss(); identifiers.remove(it) } }, 4000)
  }

  private fun dismissIdentifiers() { identifiers.forEach { it.dismiss() }; identifiers.clear() }

  private fun record(code: String) {
    events.addLast(JSONObject().put("at_ms", System.currentTimeMillis()).put("event", code)
      .put("generation", generation).put("phase", phase).put("display_id", displayId))
    while (events.size > 40) events.removeFirst()
  }

  private fun diagnostics(): JSONObject {
    val info = displays()
    val list = info.getJSONArray("displays")
    // User-assigned receiver names can contain personal information.
    for (index in 0 until list.length()) list.getJSONObject(index).remove("name")
    return JSONObject().put("session", session()).put("foreground", foreground)
      .put("display_info", info).put("output", telemetry).put("events", JSONArray(events.toList()))
  }

  fun destroy() {
    manager.unregisterDisplayListener(this)
    handler.removeCallbacksAndMessages(null)
    dismissIdentifiers()
    stop("destroyed")
    host = null
  }
}

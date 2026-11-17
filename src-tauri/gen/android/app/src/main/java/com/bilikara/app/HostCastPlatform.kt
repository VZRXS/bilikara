package com.bilikara.app

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.annotation.Keep
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import org.json.JSONObject
import java.lang.ref.WeakReference

/** JNI-only adapter. No WebView message or JavaScript interface exposes locks. */
@Keep
object HostCastPlatform {
  private lateinit var context: Context
  private lateinit var multicast: MulticastLeases
  private var activity = WeakReference<Activity>(null)
  @Volatile private var alive = true
  private val main = Handler(Looper.getMainLooper())

  @JvmStatic @Keep
  fun initialize(host: Activity): Boolean {
    if (::context.isInitialized) return false
    context = host.applicationContext
    activity = WeakReference(host)
    HostMediaPlayback.foreground = (host as? LifecycleOwner)?.lifecycle?.currentState
      ?.isAtLeast(Lifecycle.State.RESUMED) == true
    multicast = MulticastLeases {
      val manager = context.getSystemService(Context.WIFI_SERVICE) as WifiManager
      val resource = manager.createMulticastLock("bilikara:cast-discovery").apply { setReferenceCounted(false) }
      object : CastResourceLock {
        override val held get() = resource.isHeld
        override fun acquire() = resource.acquire()
        override fun release() = resource.release()
      }
    }
    host.application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityResumed(value: Activity) {
        if (value is MainActivity) { activity = WeakReference(value); alive = true; HostMediaPlayback.foreground = true }
      }
      override fun onActivityPaused(value: Activity) {
        if (activity.get() === value) HostMediaPlayback.foreground = false
      }
      override fun onActivityDestroyed(value: Activity) {
        if (activity.get() !== value) return
        activity.clear()
        HostMediaPlayback.foreground = false
        // Configuration recreation must not tear down an active cast/scan.
        if (!value.isChangingConfigurations) {
          synchronized(multicast) { alive = false; multicast.releaseAll() }
          HostMediaPlayback.stopFromPlatform(context, 2)
        }
      }
      override fun onActivityCreated(value: Activity, state: Bundle?) { }
      override fun onActivityStarted(value: Activity) { }
      override fun onActivityStopped(value: Activity) { }
      override fun onActivitySaveInstanceState(value: Activity, state: Bundle) { }
    })
    return true
  }

  @JvmStatic @Keep fun acquireMulticast(id: Long): Boolean = synchronized(multicast) {
    alive && multicast.acquire(id)
  }
  @JvmStatic @Keep fun releaseMulticast(id: Long) = multicast.release(id)
  @JvmStatic @Keep fun updateNetworkPlayback(id: Long, mode: Int): Int {
    val result = HostMediaPlayback.update(context, mode, id)
    if (mode != 0 && result == 0) requestNotificationPermission()
    return result
  }
  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT < 33) return
    main.post {
      val host = activity.get() ?: return@post
      if (!HostMediaPlayback.foreground || host.isFinishing) return@post
      val preferences = context.getSharedPreferences("cast-platform", Context.MODE_PRIVATE)
      if (preferences.getBoolean("notification-requested", false)) return@post
      preferences.edit().putBoolean("notification-requested", true).apply()
      if (host.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        try { host.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 8041) }
        catch (_: RuntimeException) { /* Refusal never prevents foreground output. */ }
      }
    }
  }

  @JvmStatic @Keep fun networkFacts(): String {
    val facts = JSONObject().put("default_network", "unknown")
      .put("wifi_connected", JSONObject.NULL).put("wifi_validated", JSONObject.NULL)
      .put("vpn_active", JSONObject.NULL).put("battery_optimization_ignored", JSONObject.NULL)
      .put("multicast_acquired", multicast.status() ?: JSONObject.NULL)
      .put("wifi_lock_mode", if (Build.VERSION.SDK_INT >= 34) "low_latency" else "high_perf")
    try {
      val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val active = manager.activeNetwork
      val capabilities = active?.let { manager.getNetworkCapabilities(it) }
      val type = when {
        active == null -> "none"
        capabilities == null -> "unknown"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> "other"
      }
      @Suppress("DEPRECATION")
      val networks = manager.allNetworks.mapNotNull { manager.getNetworkCapabilities(it) }
      val wifi = networks.filter { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
        !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) }
      facts.put("default_network", type).put("wifi_connected", wifi.isNotEmpty())
        .put("wifi_validated", if (wifi.isEmpty()) JSONObject.NULL else
          wifi.any { it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) })
        .put("vpn_active", networks.any { it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) })
    } catch (_: RuntimeException) { /* Unknown stays unknown; never include exception text. */ }
    try {
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      facts.put("battery_optimization_ignored", power.isIgnoringBatteryOptimizations(context.packageName))
    } catch (_: RuntimeException) { }
    return facts.toString()
  }
}

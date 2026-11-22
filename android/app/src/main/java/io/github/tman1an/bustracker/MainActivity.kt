package io.github.tman1an.bustracker

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.Toast
import android.window.OnBackInvokedDispatcher
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/**
 * The app is the website (all features, always up to date) in a WebView, plus what a web page cannot do:
 * share the bus location with the screen off (ShareService). The website talks to it through window.AndroidBridge.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private val site: Uri = Uri.parse(BuildConfig.SITE_URL)

    private var pendingShare: Triple<String, String, String>? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var geoCallback: Pair<String, GeolocationPermissions.Callback>? = null
    @Volatile private var toldAt = 0L // the newest sharing state the website has seen

    private companion object {
        const val REQ_SHARE = 1
        const val REQ_GEO = 2
        const val REQ_FILE = 3
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // green strip behind the status bar (matches the site's top bar), white strip behind the navigation bar / keyboard
        val top = View(this).apply { setBackgroundColor(Color.parseColor("#0B6E1C")) }
        val bottom = View(this).apply { setBackgroundColor(Color.WHITE) }
        web = WebView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(top, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0))
            addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(bottom, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            top.layoutParams = top.layoutParams.apply { height = bars.top }
            bottom.layoutParams = bottom.layoutParams.apply { height = maxOf(bars.bottom, ime.bottom) }
            root.setPadding(bars.left, 0, bars.right, 0)
            root.requestLayout()
            WindowInsetsCompat.CONSUMED
        }
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = false   // white icons on green
            isAppearanceLightNavigationBars = true
        }
        setContentView(root)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = true
            userAgentString = "$userAgentString IUBATBusApp/${BuildConfig.VERSION_NAME}"
        }
        web.addJavascriptInterface(Bridge(), "AndroidBridge")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == site.host) return false                 // our site: stay in the app
                openOutside(u)                                         // GitHub, Play Store, maps…: the right app or the browser
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (hasLocation()) callback.invoke(origin, true, false)
                else { geoCallback = origin to callback; requestPermissions(locationPerms(), REQ_GEO) }
            }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try { startActivityForResult(params.createIntent(), REQ_FILE); true }
                catch (e: ActivityNotFoundException) { fileCallback = null; false }
            }
        }

        // background sharing -> website
        ShareService.listener = { json -> toldAt = System.currentTimeMillis(); runOnUiThread { web.evaluateJavascript("window.Share&&Share._native($json)", null) } }

        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBack() }
        }
        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl(startUrl(intent))
    }

    /** A link like https://<site>/#route=… opened from WhatsApp / Messenger: open it in the app. */
    private fun startUrl(i: Intent?): String {
        val d = i?.data
        return if (d != null && d.host == site.host) d.toString() else BuildConfig.SITE_URL
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.data?.host == site.host) web.loadUrl(intent.data.toString())
    }

    private fun goBack() { if (web.canGoBack()) web.goBack() else finish() }

    // Android 13+ uses the OnBackInvokedCallback registered in onCreate (predictive back); this is for older phones.
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Android 12 and older")
    override fun onBackPressed() { goBack() }

    private fun openOutside(u: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, u)) }
        catch (e: ActivityNotFoundException) { Toast.makeText(this, "No app can open this link.", Toast.LENGTH_SHORT).show() }
    }

    private fun locationPerms() = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    private fun hasLocation() = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    private fun hasAnyLocation() = hasLocation() || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Sharing needs precise location; the notification permission (Android 13+) shows the "Sharing Bus 11" notification. */
    private fun startShare(busId: String, token: String, origin: String) {
        val missing = locationPerms().filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }.toMutableList()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            missing += Manifest.permission.POST_NOTIFICATIONS
        if (!hasLocation() && missing.isNotEmpty()) {
            pendingShare = Triple(busId, token, origin)
            requestPermissions(missing.toTypedArray(), REQ_SHARE)
            return
        }
        if (missing.contains(Manifest.permission.POST_NOTIFICATIONS) && pendingShare == null) {
            pendingShare = Triple(busId, token, origin)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_SHARE)
            return
        }
        pendingShare = null
        ShareService.start(this, busId, token, if (Uri.parse(origin).host == site.host) origin else BuildConfig.SITE_URL)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        when (requestCode) {
            REQ_SHARE -> {
                val p = pendingShare ?: return
                if (!hasLocation()) {
                    pendingShare = null
                    val msg = if (hasAnyLocation()) "Sharing needs precise location. Settings → Apps → IUBAT Bus → Location → turn on “Use precise location”."
                              else "Location permission is needed to share the bus location."
                    tellWeb(JSONObject().put("active", false).put("message", msg).put("error", true))
                    return
                }
                // notifications denied is fine: sharing still works, Android just hides the notification
                pendingShare = null
                ShareService.start(this, p.first, p.second, p.third)
            }
            REQ_GEO -> geoCallback?.let { (origin, cb) -> cb.invoke(origin, hasAnyLocation(), false); geoCallback = null }
        }
    }

    @Deprecated("Activity result API needs AndroidX Activity; this keeps the app small")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        }
    }

    private fun tellWeb(s: JSONObject) = runOnUiThread { web.evaluateJavascript("window.Share&&Share._native($s)", null) }

    override fun onResume() {
        super.onResume()
        web.onResume()
        // catch up on anything newer than what the website has seen (e.g. sharing ended while the app was closed)
        val s = ShareService.state
        if (s.optLong("at") > toldAt) { toldAt = s.optLong("at"); tellWeb(s) }
    }

    override fun onPause() { web.onPause(); super.onPause() }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        ShareService.listener = null // sharing keeps running; the website picks it up again via state() when reopened
        web.destroy()
        super.onDestroy()
    }

    /** Called from the website's JavaScript (on a background thread). */
    inner class Bridge {
        @JavascriptInterface fun startShare(busId: String, token: String, origin: String) { runOnUiThread { this@MainActivity.startShare(busId, token, origin) } }
        @JavascriptInterface fun stopShare() { runOnUiThread { ShareService.stop(this@MainActivity) } }
        @JavascriptInterface fun state(): String = ShareService.state.toString()
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
    }
}

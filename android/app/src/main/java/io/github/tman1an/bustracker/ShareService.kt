package io.github.tman1an.bustracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Shares the rider's location for one bus while the screen is off.
 *
 * A foreground service (with its ongoing notification) started from the app, so it only needs the normal
 * "while using the app" location permission. Location comes from Google Play services' fused location
 * provider (free, no API key): GPS + Wi-Fi + cell + sensors, with a Doppler speed that is ~0 in a traffic jam.
 *
 * Every fix goes to the same /api/share endpoint as the website, so the server runs the same checks
 * (on the route, moving like a bus, slots, trip windows) and gives the same XP.
 */
class ShareService : Service() {

    companion object {
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"
        private const val CHANNEL = "share"
        private const val NOTIFY_ID = 11
        private const val SEND_MS = 5_000L           // same pace as the website
        private const val MAX_MS = 3 * 3600_000L     // safety: never share for more than 3 hours
        private const val STILL_M = 5f                // moved less than this since the last send = standing still

        /** Latest state, read by the website through AndroidBridge.state() (JSON). */
        @Volatile var state: JSONObject = JSONObject().put("active", false)
            private set
        /** The open app listens here to forward the state to the website. */
        @Volatile var listener: ((String) -> Unit)? = null

        private fun publish(s: JSONObject) {
            s.put("at", System.currentTimeMillis())
            state = s
            listener?.invoke(s.toString())
        }

        fun start(ctx: Context, busId: String, token: String, site: String) {
            val i = Intent(ctx, ShareService::class.java).setAction(ACTION_START)
                .putExtra("busId", busId).putExtra("token", token).putExtra("site", site)
            androidx.core.content.ContextCompat.startForegroundService(ctx, i)
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, ShareService::class.java).setAction(ACTION_STOP))
        }
    }

    private val io = Executors.newSingleThreadExecutor()
    private val fused by lazy { LocationServices.getFusedLocationProviderClient(this) }
    private var busId = ""
    private var token = ""
    private var site = ""
    private var startedAt = 0L
    private var lastSent = 0L
    private var lastSentLoc: Location? = null
    private var latest: Location? = null
    private var sending = false
    private var running = false
    private var xp = 0
    private var thanks = 0

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val loc = result.lastLocation ?: return
            latest = loc
            val now = System.currentTimeMillis()
            // verified: my phone is the bus, so let the open app move it with every fix (about once a second)
            if (state.optString("status") == "verified" && state.optBoolean("active"))
                publish(base().put("status", "verified").put("message", state.optString("message")))
            if (now - startedAt > MAX_MS) { finish("Sharing stopped after 3 hours. Thank you!", false); return }
            if (!sending && now - lastSent >= SEND_MS - 500) send(loc)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { finish(null, false, tellServer = true); return START_NOT_STICKY }
        val bus = intent?.getStringExtra("busId") ?: return START_NOT_STICKY.also { stopSelf() }
        val wasOtherBus = running && bus != busId
        busId = bus
        token = intent.getStringExtra("token") ?: ""
        site = (intent.getStringExtra("site") ?: BuildConfig.SITE_URL).trimEnd('/')
        if (!running || wasOtherBus) { xp = 0; thanks = 0; lastSent = 0; lastSentLoc = null; startedAt = System.currentTimeMillis() }

        createChannel()
        ServiceCompat.startForeground(this, NOTIFY_ID, notification("Getting your location…"),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0)
        publish(base().put("status", "starting").put("message", "Getting your location…"))

        if (!running) {
            running = true
            val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1_000L)
                .setMinUpdateIntervalMillis(1_000L)
                .setMinUpdateDistanceMeters(0f)          // keep getting fixes while standing still (fresh time, speed ~0)
                .setWaitForAccurateLocation(false)
                .build()
            try {
                fused.requestLocationUpdates(req, callback, Looper.getMainLooper())
            } catch (e: SecurityException) {
                finish("Location permission is missing. Allow location for IUBAT Bus and try again.", true)
            }
        }
        return START_NOT_STICKY // if Android kills it, the rider sees sharing stopped instead of a silent restart
    }

    private fun base(): JSONObject = JSONObject()
        .put("active", running).put("busId", busId).put("xp", xp).put("thanks", thanks).put("sentAt", lastSent)
        .apply {
            latest?.let {
                put("lat", it.latitude); put("lng", it.longitude); put("acc", it.accuracy.toDouble()); put("fixAt", it.time)
                if (it.hasSpeed()) put("speed", it.speed.toDouble())
            }
        }

    /** Speed to report: the GPS (Doppler) speed, or 0 when the bus has not moved since the last send (traffic jam, stop). */
    private fun speedOf(loc: Location): Float? {
        val prev = lastSentLoc
        if (prev != null && loc.time - prev.time >= 4_000 && loc.distanceTo(prev) < STILL_M) return 0f
        return if (loc.hasSpeed()) loc.speed else null
    }

    private fun send(loc: Location) {
        sending = true
        lastSent = System.currentTimeMillis()
        val speed = speedOf(loc)
        val body = JSONObject().put("busId", busId).put("lat", loc.latitude).put("lng", loc.longitude).put("acc", loc.accuracy.toDouble())
        if (speed != null) body.put("speed", speed.toDouble())
        if (loc.hasBearing() && (speed ?: 0f) > 1f) body.put("heading", loc.bearing.toDouble())
        val wake = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "IUBATBus:send").apply { acquire(20_000) } // finish this one request
        io.execute {
            var code = 0
            var reply: JSONObject? = null
            try {
                val (c, text) = post("$site/api/share", body)
                code = c
                reply = runCatching { JSONObject(text) }.getOrNull()
            } catch (e: Exception) {
                code = -1
            } finally {
                if (wake.isHeld) wake.release()
            }
            android.os.Handler(Looper.getMainLooper()).post { onReply(code, reply, loc) }
        }
    }

    private fun onReply(code: Int, j: JSONObject?, loc: Location) {
        sending = false
        if (!running) return
        if (code == -1) { update(if (lastSentLoc == null) "starting" else state.optString("status", "starting"), "Network problem, retrying…"); return }
        if (code !in 200..299) { finish(j?.optString("error")?.takeIf { it.isNotEmpty() } ?: "Sharing stopped.", true); return }
        lastSentLoc = loc
        if (j == null) return
        if (j.has("xp")) xp = maxOf(xp, j.optInt("xp"))
        if (j.has("thanks")) thanks = j.optInt("thanks")
        val status = j.optString("status")
        val message = j.optString("message")
        if (status == "arrived") { finish(message + if (xp > 0) " You earned $xp XP on this ride." else "", false); return }
        update(status, message, if (j.has("progress")) j.optInt("progress") else null)
    }

    private fun update(status: String, message: String, progress: Int? = null) {
        val s = base().put("status", status).put("message", message)
        if (progress != null) s.put("progress", progress)
        publish(s)
        val label = when (status) {
            "verified" -> "✓ Live for everyone"
            "backup" -> "✓ Backup (the bus phone is live)"
            "checking" -> "Checking that you are on the bus…"
            else -> message
        }
        getSystemService(NotificationManager::class.java).notify(NOTIFY_ID, notification(label))
    }

    /** Stop sharing; [message] is shown in the app afterwards (e.g. "the bus reached campus"). */
    private fun finish(message: String?, error: Boolean, tellServer: Boolean = false) {
        val wasRunning = running
        running = false
        fused.removeLocationUpdates(callback)
        if (tellServer && wasRunning && token.isNotEmpty()) {
            val t = token; val s = site
            io.execute { runCatching { post("$s/api/share", JSONObject().put("action", "stop"), t) } }
        }
        val out = JSONObject().put("active", false).put("busId", busId).put("xp", xp)
        if (message != null) out.put("message", message).put("error", error)
        publish(out)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun post(url: String, body: JSONObject, auth: String = token): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.connectTimeout = 10_000
            c.readTimeout = 10_000
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.setRequestProperty("Authorization", "Bearer $auth")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = c.responseCode
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return code to text
        } finally {
            c.disconnect()
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ch = NotificationChannel(CHANNEL, getString(R.string.channel_share), NotificationManager.IMPORTANCE_LOW)
        ch.description = getString(R.string.channel_share_desc)
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun notification(text: String): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags)
        val stop = PendingIntent.getService(this, 1,
            Intent(this, ShareService::class.java).setAction(ACTION_STOP), flags)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setColor(0xFF0B6E1C.toInt())
            .setContentTitle("Sharing Bus $busId")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.stop), stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    override fun onDestroy() {
        if (running) finish(null, false, tellServer = true)
        io.shutdown()
        super.onDestroy()
    }
}

package io.github.sayach.dshmobile

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Task notifications for #46. The WebView cannot use the Web Notification
 * API (platform limitation), so the page posts {event:'notify.show'} over the
 * existing WebMessage bridge and the shell raises a real system notification.
 *
 * Tapping a notification wakes the app task (launchMode=singleTask) and
 * brings the already-running page forward; SESSION_ID_EXTRA is carried on the
 * tap intent for a future deep link into that session and is not yet routed.
 */
internal object Notifications {
    const val CHANNEL_ID = "dsh-mobile-tasks"
    private const val REQUEST_TAG_PREFIX = "task"
    const val SESSION_ID_EXTRA = "io.github.sayach.dshmobile.extra.NOTIFY_SESSION"
    const val NOTIFICATION_PERMISSION_REQUEST = 5104

    internal data class Payload(
        val title: String,
        val body: String,
        val tag: String,
        val sessionId: String,
    )

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notify_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        channel.description = context.getString(R.string.notify_channel_description)
        manager.createNotificationChannel(channel)
    }

    fun permissionGranted(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    fun requestPermission(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (permissionGranted(activity)) return
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
    }

    fun post(context: Context, payload: Payload) {
        if (!permissionGranted(context)) return
        ensureChannel(context)
        val click = PendingIntent.getActivity(
            context,
            payload.tag.hashCode(),
            Intent(context, MainActivity::class.java)
                .putExtra(SESSION_ID_EXTRA, payload.sessionId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(payload.title.take(120))
            .setContentText(payload.body.take(256))
            .setAutoCancel(true)
            .setContentIntent(click)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.notify("$REQUEST_TAG_PREFIX-${payload.tag}", 0, notification)
    }
}

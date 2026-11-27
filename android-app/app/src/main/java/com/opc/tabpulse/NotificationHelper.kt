package com.opc.tabpulse

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlin.math.abs

object NotificationHelper {
    const val CHANNEL_ALERTS = "tabpulse_alerts_v1"
    const val CHANNEL_GUARDIAN = "tabpulse_guardian_v1"
    const val GUARDIAN_NOTIFICATION_ID = 1001
    const val TEST_NOTIFICATION_ID = 1002
    const val EXTRA_OPEN_WATCH_ID = "open_watch_id"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val alertSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val alertChannel = NotificationChannel(
            CHANNEL_ALERTS,
            "平台新消息提醒",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "闲鱼、小红书、邮箱、小众平台等有新消息或需要登录时立即横幅+响铃提醒"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 220, 120, 220)
            enableLights(true)
            setShowBadge(true)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setSound(
                alertSound,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
        }
        nm.createNotificationChannel(alertChannel)

        val guardianChannel = NotificationChannel(
            CHANNEL_GUARDIAN,
            "后台守护状态条",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "保持消息总管在手机后台持续监听各平台消息，无声音打扰"
            enableVibration(false)
            setSound(null, null)
            setShowBadge(false)
        }
        nm.createNotificationChannel(guardianChannel)
    }

    fun hasNotificationPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return NotificationManagerCompat.from(context).areNotificationsEnabled()
        }
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED && NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    fun buildGuardianNotification(context: Context, watchCount: Int, totalUnread: Int): Notification {
        ensureChannels(context)
        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPi = PendingIntent.getActivity(
            context,
            101,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(context, MonitorForegroundService::class.java).apply {
            action = MonitorForegroundService.ACTION_STOP
        }
        val stopPi = PendingIntent.getService(
            context,
            102,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val title = if (totalUnread > 0) {
            "消息总管 · $totalUnread 条未读消息"
        } else {
            "消息总管守护中"
        }
        val text = if (watchCount > 0) {
            "正在后台守护 $watchCount 个平台（登录持久保持，来消息秒提醒）"
        } else {
            "打开消息总管，从 86 个常用/小众平台里一键添加吧"
        }

        return NotificationCompat.Builder(context, CHANNEL_GUARDIAN)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openPi)
            .addAction(0, "暂停守护", stopPi)
            .build()
    }

    fun notifyIncomingMessage(context: Context, watch: WatchItem, unreadCount: Int, snippet: String) {
        if (!hasNotificationPermission(context)) return
        ensureChannels(context)
        val notifId = 2000 + (abs(watch.id.hashCode()) % 30000)

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_OPEN_WATCH_ID, watch.id)
        }
        val pi = PendingIntent.getActivity(
            context,
            notifId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val title = "🔴 ${watch.name}（${unreadCount}条未读）"
        val body = snippet.ifBlank { "收到新消息，点此直接查看并回复" }

        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setNumber(unreadCount)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()

        runCatching {
            NotificationManagerCompat.from(context).notify(notifId, notification)
        }
    }

    fun notifyAuthExpired(context: Context, watch: WatchItem) {
        if (!hasNotificationPermission(context)) return
        ensureChannels(context)
        val notifId = 40000 + (abs(watch.id.hashCode()) % 10000)

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_OPEN_WATCH_ID, watch.id)
        }
        val pi = PendingIntent.getActivity(
            context,
            notifId,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle("🟠 ${watch.name} 需要重新登录")
            .setContentText("点此打开快速续登，登录完成后继续持久收消息")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()

        runCatching {
            NotificationManagerCompat.from(context).notify(notifId, notification)
        }
    }

    fun sendTestNotification(context: Context): Boolean {
        if (!hasNotificationPermission(context)) return false
        ensureChannels(context)
        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            context,
            TEST_NOTIFICATION_ID,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle("🔔 消息总管通知测试成功！")
            .setContentText("手机横幅、提示音和点按直达全部正常，有平台来消息就会这样秒提醒你。")
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText("手机横幅、提示音和点按直达全部正常，有平台来消息就会这样秒提醒你。")
            )
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()

        return runCatching {
            NotificationManagerCompat.from(context).notify(TEST_NOTIFICATION_ID, notification)
            true
        }.getOrDefault(false)
    }

    fun cancelWatchNotification(context: Context, watchId: String) {
        val notifId = 2000 + (abs(watchId.hashCode()) % 30000)
        runCatching {
            NotificationManagerCompat.from(context).cancel(notifId)
        }
    }
}

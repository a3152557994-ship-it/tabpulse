package com.opc.tabpulse

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : AppCompatActivity(), PlatformWebHostCallbacks {

    private lateinit var rootFrame: FrameLayout
    private lateinit var dashboardWebView: WebView

    // Native Platform View overlay (hosts reparented live WebView from BackgroundMonitorPool)
    private lateinit var platformOverlay: LinearLayout
    private lateinit var platformBackBtn: TextView
    private lateinit var platformTitleTv: TextView
    private lateinit var platformUaBtn: TextView
    private lateinit var platformQrBtn: TextView
    private lateinit var platformReloadBtn: TextView
    private lateinit var platformMoreBtn: TextView
    private lateinit var platformProgress: ProgressBar
    private lateinit var platformWebContainer: FrameLayout
    private lateinit var externalBanner: LinearLayout
    private lateinit var externalBannerText: TextView

    // Companion PC Bridge overlay (optional: connects to user's desktop 《消息总管》)
    private lateinit var companionOverlay: LinearLayout
    private lateinit var companionWebView: WebView

    private var activeWatchId: String? = null
    private var pendingExternalUrl: String? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var dashboardReady = false

    private val repoListener: () -> Unit = {
        runOnUiThread {
            pushStateToDashboard()
            refreshPlatformToolbarBadge()
        }
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            toast("已开启通知权限！有新消息会第一时间弹窗提醒")
        } else {
            toast("未允许通知权限，可在系统设置里随时打开")
        }
        pushStateToDashboard()
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = filePathCallback
        filePathCallback = null
        if (cb == null) return@registerForActivityResult
        val uris: Array<Uri>? = if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            when {
                data?.clipData != null -> {
                    val count = data.clipData!!.itemCount
                    Array(count) { i -> data.clipData!!.getItemAt(i).uri }
                }
                data?.data != null -> arrayOf(data.data!!)
                else -> null
            }
        } else null
        cb.onReceiveValue(uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        buildLayout()
        TabPulseApp.instance.repository.addListener(repoListener)
        TabPulseApp.instance.monitorPool.hostCallbacks = this

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    companionOverlay.visibility == View.VISIBLE -> {
                        if (companionWebView.canGoBack()) {
                            companionWebView.goBack()
                        } else {
                            closeCompanionOverlay()
                        }
                    }
                    platformOverlay.visibility == View.VISIBLE -> {
                        val wid = activeWatchId
                        val currentWv = platformWebContainer.getChildAt(0) as? WebView
                        if (currentWv != null && currentWv.canGoBack()) {
                            currentWv.goBack()
                        } else if (wid != null) {
                            closePlatformOverlay()
                        }
                    }
                    else -> {
                        // Minimize instead of killing so background guardian continues smoothly
                        moveTaskToBack(true)
                    }
                }
            }
        })

        // Start foreground guardian automatically if enabled
        if (TabPulseApp.instance.repository.getSettings().guardianEnabled) {
            MonitorForegroundService.start(this)
        }

        // Request Android 13+ notification permission politely on first launch
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !NotificationHelper.hasNotificationPermission(this)
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        handleIncomingIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        TabPulseApp.instance.monitorPool.hostCallbacks = this
        pushStateToDashboard()
        if (TabPulseApp.instance.repository.getSettings().guardianEnabled && !MonitorForegroundService.isRunning) {
            MonitorForegroundService.start(this)
        }
    }

    override fun onPause() {
        super.onPause()
        TabPulseApp.instance.monitorPool.snapshotAllCookies()
    }

    override fun onDestroy() {
        TabPulseApp.instance.repository.removeListener(repoListener)
        if (TabPulseApp.instance.monitorPool.hostCallbacks === this) {
            TabPulseApp.instance.monitorPool.hostCallbacks = null
        }
        TabPulseApp.instance.monitorPool.detachFromActivity(activeWatchId)
        runCatching { companionWebView.destroy() }
        runCatching { dashboardWebView.destroy() }
        super.onDestroy()
    }

    private fun handleIncomingIntent(intent: Intent?) {
        val openWatchId = intent?.getStringExtra(NotificationHelper.EXTRA_OPEN_WATCH_ID)
        if (!openWatchId.isNullOrBlank()) {
            openPlatformWatch(openWatchId)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildLayout() {
        rootFrame = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0B1120"))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        ViewCompat.setOnApplyWindowInsetsListener(rootFrame) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        // 1. Local Dashboard WebView
        dashboardWebView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0B1120"))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            addJavascriptInterface(AppUiBridge(), "TabPulseAppUI")
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    dashboardReady = true
                    pushStateToDashboard()
                }
            }
            loadUrl("file:///android_asset/app-ui.html")
        }
        rootFrame.addView(dashboardWebView)

        // 2. Native Platform Overlay
        platformOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0B1120"))
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#111827"))
            setPadding(dp(8), dp(6), dp(8), dp(6))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(50)
            )
        }

        platformBackBtn = makeToolbarPill("← 返回", "#1E293B", "#F8FAFC").apply {
            setOnClickListener { closePlatformOverlay() }
        }
        topBar.addView(platformBackBtn)

        platformTitleTv = TextView(this).apply {
            setTextColor(Color.parseColor("#F8FAFC"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f)
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(8), 0, dp(6), 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        topBar.addView(platformTitleTv)

        platformUaBtn = makeToolbarPill("💻", "#1E293B", "#93C5FD").apply {
            setOnClickListener {
                val wid = activeWatchId ?: return@setOnClickListener
                val updated = TabPulseApp.instance.repository.toggleDesktopUa(wid) ?: return@setOnClickListener
                updateUaButton(updated.desktopUa)
                TabPulseApp.instance.monitorPool.reloadWatch(wid, resetToHome = false)
                toast(if (updated.desktopUa) "已切到电脑网页版（防强制跳App）" else "已切到手机网页版")
            }
        }
        topBar.addView(platformUaBtn)

        platformQrBtn = makeToolbarPill("📷存码", "#1D4ED8", "#FFFFFF").apply {
            setOnClickListener { saveCurrentViewToGallery() }
        }
        topBar.addView(platformQrBtn)

        platformReloadBtn = makeToolbarPill("↻", "#1E293B", "#E2E8F0").apply {
            setOnClickListener {
                activeWatchId?.let { TabPulseApp.instance.monitorPool.reloadWatch(it, resetToHome = false) }
            }
        }
        topBar.addView(platformReloadBtn)

        platformMoreBtn = makeToolbarPill("⋮", "#1E293B", "#E2E8F0").apply {
            setOnClickListener { showPlatformMoreMenu(it) }
        }
        topBar.addView(platformMoreBtn)

        platformOverlay.addView(topBar)

        platformProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(3))
        }
        platformOverlay.addView(platformProgress)

        platformWebContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }
        platformOverlay.addView(platformWebContainer)

        // Optional non-blocking External App Scheme Banner (anti-hijack + easy App OAuth authorize!)
        externalBanner = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#1E293B"))
            setPadding(dp(12), dp(8), dp(10), dp(8))
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        externalBannerText = TextView(this).apply {
            setTextColor(Color.parseColor("#F8FAFC"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            text = "页面想唤起外部 App（可用于快捷授权登录）"
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        externalBanner.addView(externalBannerText)

        val allowExtBtn = makeToolbarPill("允许打开", "#2563EB", "#FFFFFF").apply {
            setOnClickListener {
                val url = pendingExternalUrl
                externalBanner.visibility = View.GONE
                pendingExternalUrl = null
                if (!url.isNullOrBlank()) {
                    launchExternalUri(url)
                }
            }
        }
        externalBanner.addView(allowExtBtn)

        val dismissExtBtn = makeToolbarPill("忽略", "#334155", "#CBD5E1").apply {
            setOnClickListener {
                externalBanner.visibility = View.GONE
                pendingExternalUrl = null
            }
        }
        externalBanner.addView(dismissExtBtn)
        platformOverlay.addView(externalBanner)

        rootFrame.addView(platformOverlay)

        // 3. Companion PC Overlay
        companionOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0B1120"))
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        val compBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#111827"))
            setPadding(dp(10), dp(6), dp(10), dp(6))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48))
        }
        compBar.addView(makeToolbarPill("← 回手机版", "#1E293B", "#F8FAFC").apply {
            setOnClickListener { closeCompanionOverlay() }
        })
        compBar.addView(TextView(this).apply {
            text = "🖥️ 家里电脑 · 随身工作台"
            setTextColor(Color.parseColor("#F8FAFC"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(10), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        compBar.addView(makeToolbarPill("↻ 刷新", "#1E293B", "#E2E8F0").apply {
            setOnClickListener { companionWebView.reload() }
        })
        companionOverlay.addView(compBar)

        companionWebView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0B1120"))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.userAgentString = BackgroundMonitorPool.MOBILE_CHROME_UA
            runCatching {
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val scheme = request?.url?.scheme?.lowercase().orEmpty()
                    return !(scheme == "http" || scheme == "https")
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    runCatching { CookieManager.getInstance().flush() }
                }
            }
        }
        companionOverlay.addView(companionWebView)
        rootFrame.addView(companionOverlay)

        setContentView(rootFrame)
    }

    private fun makeToolbarPill(label: String, bgHex: String, fgHex: String): TextView {
        val bg = GradientDrawable().apply {
            setColor(Color.parseColor(bgHex))
            cornerRadius = dp(8).toFloat()
        }
        return TextView(this).apply {
            text = label
            setTextColor(Color.parseColor(fgHex))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            typeface = Typeface.DEFAULT_BOLD
            background = bg
            setPadding(dp(10), dp(6), dp(10), dp(6))
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.marginStart = dp(5)
            layoutParams = lp
        }
    }

    private fun openPlatformWatch(watchId: String) {
        val watch = TabPulseApp.instance.repository.getWatch(watchId) ?: run {
            toast("该平台不存在或已删除")
            return
        }
        if (activeWatchId != null && activeWatchId != watchId) {
            TabPulseApp.instance.monitorPool.detachFromActivity(activeWatchId)
        }
        activeWatchId = watchId
        pendingExternalUrl = null
        externalBanner.visibility = View.GONE

        platformTitleTv.text = watch.name
        updateUaButton(watch.desktopUa)
        refreshPlatformToolbarBadge()

        TabPulseApp.instance.monitorPool.attachToContainer(watch, this, platformWebContainer)
        platformOverlay.visibility = View.VISIBLE
        companionOverlay.visibility = View.GONE
        pushStateToDashboard()
    }

    private fun closePlatformOverlay() {
        val wid = activeWatchId
        activeWatchId = null
        pendingExternalUrl = null
        externalBanner.visibility = View.GONE
        platformWebContainer.removeAllViews()
        TabPulseApp.instance.monitorPool.detachFromActivity(wid)
        platformOverlay.visibility = View.GONE
        pushStateToDashboard()
    }

    private fun openCompanionOverlay(rawUrl: String) {
        val clean = UrlHelpers.normalizeHttpUrl(rawUrl)
        if (clean == null) {
            toast("请输入正确的电脑随身版链接（https://...）")
            return
        }
        TabPulseApp.instance.repository.updateSettings { it.copy(companionUrl = clean) }
        companionWebView.loadUrl(clean)
        companionOverlay.visibility = View.VISIBLE
        platformOverlay.visibility = View.GONE
    }

    private fun closeCompanionOverlay() {
        companionOverlay.visibility = View.GONE
        pushStateToDashboard()
    }

    private fun updateUaButton(desktopUa: Boolean) {
        platformUaBtn.text = if (desktopUa) "💻电脑" else "📱手机"
    }

    private fun refreshPlatformToolbarBadge() {
        val total = TabPulseApp.instance.repository.totalUnreadCount()
        platformBackBtn.text = if (total > 0) "← 返回($total)" else "← 返回"
    }

    private fun showPlatformMoreMenu(anchor: View) {
        val wid = activeWatchId ?: return
        val watch = TabPulseApp.instance.repository.getWatch(wid) ?: return
        val menu = PopupMenu(this, anchor)
        menu.menu.add(0, 1, 0, "🏠 回到平台首页")
        menu.menu.add(0, 2, 1, "🔗 复制当前网址")
        menu.menu.add(0, 3, 2, "↗ 用系统浏览器 / 外部App打开")
        menu.menu.add(0, 4, 3, if (watch.muted) "🔔 恢复此平台消息提醒" else "🔕 静音此平台提醒")
        menu.menu.add(0, 5, 4, "🔌 解绑并清除登录状态")
        menu.menu.add(0, 6, 5, "🗑️ 删除此平台")

        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> TabPulseApp.instance.monitorPool.reloadWatch(wid, resetToHome = true)
                2 -> {
                    val url = TabPulseApp.instance.monitorPool.getCurrentUrl(wid)
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("url", url))
                    toast("已复制网址")
                }
                3 -> {
                    val url = TabPulseApp.instance.monitorPool.getCurrentUrl(wid)
                    launchExternalUri(url)
                }
                4 -> {
                    val next = TabPulseApp.instance.repository.toggleMute(wid)
                    toast(if (next?.muted == true) "已静音此平台提醒" else "已恢复此平台消息提醒")
                }
                5 -> confirmUnbindWatch(watch)
                6 -> confirmDeleteWatch(watch)
            }
            true
        }
        menu.show()
    }

    private fun confirmUnbindWatch(watch: WatchItem) {
        AlertDialog.Builder(this)
            .setTitle("解绑「${watch.name}」？")
            .setMessage("解绑后将彻底清除本平台在手机上的登录 Cookie 和缓存，需要重新扫码/登录才会继续收消息。")
            .setPositiveButton("确认解绑") { _, _ ->
                TabPulseApp.instance.monitorPool.destroyWatchView(watch.id, clearCache = true)
                TabPulseApp.instance.repository.unbindWatch(watch.id)
                if (activeWatchId == watch.id) closePlatformOverlay()
                toast("已解绑「${watch.name}」并清除登录信息")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun confirmDeleteWatch(watch: WatchItem) {
        AlertDialog.Builder(this)
            .setTitle("删除「${watch.name}」？")
            .setMessage("会同时清除此平台的登录状态并从列表移除。")
            .setPositiveButton("确认删除") { _, _ ->
                TabPulseApp.instance.monitorPool.destroyWatchView(watch.id, clearCache = true)
                TabPulseApp.instance.repository.removeWatch(watch.id)
                if (activeWatchId == watch.id) closePlatformOverlay()
                toast("已删除「${watch.name}」")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun saveCurrentViewToGallery() {
        val targetView = platformWebContainer.getChildAt(0) ?: return
        val w = targetView.width
        val h = targetView.height
        if (w <= 0 || h <= 0) {
            toast("页面还在加载中，请稍等一秒再点")
            return
        }
        runCatching {
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bmp)
            targetView.draw(canvas)

            val fileName = "消息总管_扫码_${System.currentTimeMillis()}.png"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
                    put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                    put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/消息总管")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("MediaStore insert failed")
                contentResolver.openOutputStream(uri)?.use { out ->
                    bmp.compress(Bitmap.CompressFormat.PNG, 95, out)
                }
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
            } else {
                @Suppress("DEPRECATION")
                MediaStore.Images.Media.insertImage(contentResolver, bmp, fileName, "消息总管扫码图片")
            }
            bmp.recycle()
            toast("已存到相册！打开微信/闲鱼/小红书点「扫一扫→相册」即可秒登")
        }.onFailure {
            toast("保存截图失败，可直接用手机系统截屏扫码")
        }
    }

    private fun launchExternalUri(rawUrl: String) {
        runCatching {
            val intent = if (rawUrl.startsWith("intent://", ignoreCase = true)) {
                Intent.parseUri(rawUrl, Intent.URI_INTENT_SCHEME)
            } else {
                Intent(Intent.ACTION_VIEW, Uri.parse(rawUrl))
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
        }.onFailure {
            toast("手机上未安装对应的外部 App")
        }
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryOptimizationWhitelist() {
        runCatching {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        }.onFailure {
            runCatching {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }.onFailure {
                toast("请在手机「设置 → 应用管理 → 消息总管 → 电池」里选择无限制")
            }
        }
    }

    private fun openAppNotificationSettings() {
        runCatching {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                    putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                }
            } else {
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:$packageName")
                }
            }
            startActivity(intent)
        }
    }

    private fun pushStateToDashboard() {
        if (!dashboardReady) return
        val app = TabPulseApp.instance
        val stateJson = app.repository.buildStateJson(
            guardianRunning = MonitorForegroundService.isRunning,
            notificationsGranted = NotificationHelper.hasNotificationPermission(this),
            batteryWhitelisted = NotificationHelper.isIgnoringBatteryOptimizations(this)
        )
        val escaped = JSONObject.quote(stateJson)
        dashboardWebView.post {
            dashboardWebView.evaluateJavascript(
                "if (window.__onAppState) window.__onAppState(JSON.parse($escaped));",
                null
            )
        }
    }

    override fun onPageTitleChanged(watchId: String, title: String) {
        if (activeWatchId == watchId && title.isNotBlank()) {
            val watch = TabPulseApp.instance.repository.getWatch(watchId)
            platformTitleTv.text = watch?.name ?: title
        }
    }

    override fun onPageLoadingChanged(watchId: String, loading: Boolean, currentUrl: String) {
        if (activeWatchId == watchId) {
            platformProgress.visibility = if (loading) View.VISIBLE else View.GONE
        }
    }

    override fun onExternalSchemeRequested(watchId: String, externalUrl: String) {
        if (activeWatchId != watchId) return
        pendingExternalUrl = externalUrl
        val scheme = Uri.parse(externalUrl).scheme ?: "外部App"
        externalBannerText.text = "页面想唤起外部 App（$scheme），可能用于快捷登录"
        externalBanner.visibility = View.VISIBLE
    }

    override fun onShowFileChooser(
        watchId: String,
        filePathCallback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams
    ): Boolean {
        this.filePathCallback?.onReceiveValue(null)
        this.filePathCallback = filePathCallback
        return runCatching {
            val intent = params.createIntent()
            fileChooserLauncher.launch(intent)
            true
        }.getOrElse {
            this.filePathCallback = null
            false
        }
    }

    private fun dp(value: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            resources.displayMetrics
        ).toInt()
    }

    private fun toast(msg: String) {
        runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }
    }

    inner class AppUiBridge {
        @JavascriptInterface
        fun getStateJson(): String {
            val app = TabPulseApp.instance
            return app.repository.buildStateJson(
                guardianRunning = MonitorForegroundService.isRunning,
                notificationsGranted = NotificationHelper.hasNotificationPermission(this@MainActivity),
                batteryWhitelisted = NotificationHelper.isIgnoringBatteryOptimizations(this@MainActivity)
            )
        }

        @JavascriptInterface
        fun getCatalogJson(): String {
            return TabPulseApp.instance.repository.buildCatalogJson()
        }

        @JavascriptInterface
        fun addCatalogPlatform(platformId: String): String {
            val (item, isNew) = TabPulseApp.instance.repository.addFromCatalog(platformId)
            if (item != null && TabPulseApp.instance.repository.getSettings().guardianEnabled) {
                runOnUiThread {
                    MonitorForegroundService.start(this@MainActivity)
                    TabPulseApp.instance.monitorPool.warmUpWatches()
                }
            }
            return JSONObject().apply {
                put("ok", item != null)
                put("created", isNew)
                put("id", item?.id ?: "")
                put("name", item?.name ?: "")
            }.toString()
        }

        @JavascriptInterface
        fun addCustomPlatform(name: String, rawUrl: String, desktopUa: Boolean): String {
            val (item, isNew) = TabPulseApp.instance.repository.addPlatform(
                name = name,
                rawUrl = rawUrl,
                category = "自定义平台",
                group = "custom",
                loginHint = "打开页面登录，自动持久保持",
                desktopUa = desktopUa,
                allowDuplicate = false
            )
            if (item != null && TabPulseApp.instance.repository.getSettings().guardianEnabled) {
                runOnUiThread {
                    MonitorForegroundService.start(this@MainActivity)
                    TabPulseApp.instance.monitorPool.warmUpWatches()
                }
            }
            return JSONObject().apply {
                put("ok", item != null)
                put("created", isNew)
                put("id", item?.id ?: "")
                put("error", if (item == null) "网址格式不对，请输入类似 https://example.com" else "")
            }.toString()
        }

        @JavascriptInterface
        fun openWatch(watchId: String) {
            runOnUiThread { openPlatformWatch(watchId) }
        }

        @JavascriptInterface
        fun unbindWatch(watchId: String) {
            runOnUiThread {
                val watch = TabPulseApp.instance.repository.getWatch(watchId) ?: return@runOnUiThread
                confirmUnbindWatch(watch)
            }
        }

        @JavascriptInterface
        fun deleteWatch(watchId: String) {
            runOnUiThread {
                val watch = TabPulseApp.instance.repository.getWatch(watchId) ?: return@runOnUiThread
                confirmDeleteWatch(watch)
            }
        }

        @JavascriptInterface
        fun toggleMute(watchId: String) {
            TabPulseApp.instance.repository.toggleMute(watchId)
        }

        @JavascriptInterface
        fun setGuardianEnabled(enabled: Boolean) {
            TabPulseApp.instance.repository.updateSettings { it.copy(guardianEnabled = enabled) }
            runOnUiThread {
                if (enabled) {
                    MonitorForegroundService.start(this@MainActivity)
                    toast("已开启后台守护，息屏也能收消息")
                } else {
                    MonitorForegroundService.stop(this@MainActivity)
                    toast("已暂停后台守护")
                }
                pushStateToDashboard()
            }
        }

        @JavascriptInterface
        fun updateSettingsJson(rawJson: String) {
            runCatching {
                val obj = JSONObject(rawJson)
                TabPulseApp.instance.repository.updateSettings { cur ->
                    cur.copy(
                        pollIntervalSec = obj.optInt("pollIntervalSec", cur.pollIntervalSec).coerceIn(15, 300),
                        desktopUaDefault = obj.optBoolean("desktopUaDefault", cur.desktopUaDefault),
                        nightQuietEnabled = obj.optBoolean("nightQuietEnabled", cur.nightQuietEnabled),
                        notifyOnAuthExpired = obj.optBoolean("notifyOnAuthExpired", cur.notifyOnAuthExpired),
                        maxLiveTabs = obj.optInt("maxLiveTabs", cur.maxLiveTabs).coerceIn(2, 8),
                        companionUrl = if (obj.has("companionUrl")) obj.optString("companionUrl", cur.companionUrl) else cur.companionUrl
                    )
                }
            }
        }

        @JavascriptInterface
        fun sendTestNotification(): Boolean {
            if (!NotificationHelper.hasNotificationPermission(this@MainActivity)) {
                runOnUiThread {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        openAppNotificationSettings()
                    }
                }
                return false
            }
            val ok = NotificationHelper.sendTestNotification(this@MainActivity)
            toast(if (ok) "已发送测试通知！请看手机顶部横幅" else "通知发送受限，请检查系统通知权限")
            return ok
        }

        @JavascriptInterface
        fun requestBatteryWhitelist() {
            runOnUiThread { requestBatteryOptimizationWhitelist() }
        }

        @JavascriptInterface
        fun openNotificationSettings() {
            runOnUiThread { openAppNotificationSettings() }
        }

        @JavascriptInterface
        fun openCompanionUrl(rawUrl: String) {
            runOnUiThread { openCompanionOverlay(rawUrl) }
        }

        @JavascriptInterface
        fun clearMessages() {
            TabPulseApp.instance.repository.clearMessageFeed()
            toast("已清空通知记录")
        }

        @JavascriptInterface
        fun syncAllNow() {
            TabPulseApp.instance.monitorPool.warmUpWatches(runKeepAlivePing = true)
            toast("正在刷新全部平台未读消息…")
        }
    }
}

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
import android.widget.ScrollView
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
    private var nativePrivacyGateView: View? = null
    private var dashboardWebView: WebView? = null
    private var webUiInitialized = false

    // 1. Native Platform View overlay
    private lateinit var platformOverlay: LinearLayout
    private lateinit var platformBackBtn: TextView
    private lateinit var platformTitleTv: TextView
    private lateinit var platformUaBtn: TextView
    private lateinit var platformQrBtn: TextView
    private lateinit var platformReloadBtn: TextView
    private lateinit var platformMoreBtn: TextView
    private lateinit var platformProgress: ProgressBar
    private lateinit var riskBanner: LinearLayout
    private lateinit var platformWebContainer: FrameLayout
    private lateinit var externalBanner: LinearLayout
    private lateinit var externalBannerText: TextView

    // 2. Zero-URL Search-to-Add Discovery Overlay ("输名字搜官网 → ⭐ 就守这个页面")
    private lateinit var discoveryOverlay: LinearLayout
    private lateinit var discoveryTitleTv: TextView
    private lateinit var discoveryProgress: ProgressBar
    private var discoveryWebView: WebView? = null
    private var discoveryKeywordHint: String = ""

    // 3. Optional Advanced Companion Overlay
    private lateinit var companionOverlay: LinearLayout
    private var companionWebView: WebView? = null

    private var activeWatchId: String? = null
    private var pendingExternalUrl: String? = null
    private var pendingSharedIntent: Intent? = null
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
            toast("已开启通知权限！平台新消息和海外 CC 完工都会弹窗提醒")
        } else {
            toast("未允许通知权限，可在设置里随时打开")
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
        setContentView(rootFrame)

        TabPulseApp.instance.repository.addListener(repoListener)
        TabPulseApp.instance.monitorPool.hostCallbacks = this

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!webUiInitialized) {
                    finishAffinity()
                    return
                }
                when {
                    discoveryOverlay.visibility == View.VISIBLE -> {
                        val dwv = discoveryWebView
                        if (dwv != null && dwv.canGoBack()) {
                            dwv.goBack()
                        } else {
                            closeDiscoveryOverlay()
                        }
                    }
                    companionOverlay.visibility == View.VISIBLE -> {
                        val cwv = companionWebView
                        if (cwv != null && cwv.canGoBack()) {
                            cwv.goBack()
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
                        moveTaskToBack(true)
                    }
                }
            }
        })

        val settings = TabPulseApp.instance.repository.getSettings()
        if (settings.privacyAccepted) {
            ensureWebUiInitialized()
            startServicesAfterConsent()
            handleIncomingIntent(intent)
        } else {
            // Strict MIIT / Store Privacy Compliance: ZERO WebView instantiation before user taps Agree!
            pendingSharedIntent = intent
            showPureNativePrivacyGate()
        }
    }

    private fun showPureNativePrivacyGate() {
        val outer = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0B1120"))
            setPadding(dp(20), dp(24), dp(20), dp(24))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        val cardBg = GradientDrawable().apply {
            setColor(Color.parseColor("#162033"))
            cornerRadius = dp(18).toFloat()
            setStroke(dp(1), Color.parseColor("#3B82F6"))
        }
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = cardBg
            setPadding(dp(18), dp(20), dp(18), dp(18))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
            )
        }

        val titleTv = TextView(this).apply {
            text = "🔒 欢迎使用《消息总管》隐私与安全说明"
            setTextColor(Color.parseColor("#F8FAFC"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16.5f)
            typeface = Typeface.DEFAULT_BOLD
        }
        card.addView(titleTv)

        val scroll = ScrollView(this).apply {
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(310)
            )
            lp.topMargin = dp(12)
            lp.bottomMargin = dp(14)
            layoutParams = lp
        }
        val bodyTv = TextView(this).apply {
            setTextColor(Color.parseColor("#CBD5E1"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setLineSpacing(dp(3).toFloat(), 1.15f)
            text = """
                感谢使用《消息总管》（杭州数创引擎出品）。在您开始使用前，请阅读并了解以下隐私与安全保护规则：

                1. 账号 100% 本地沙盒存储
                您在软件内登录的任何第三方平台账号、密码及 Cookie 仅加密保存在您自己这部手机的本地私有目录中，绝不上传任何外部服务器；您随时点击「解绑」即可一键彻底擦除。

                2. 无需电脑 · 标准系统内核
                本软件单独一部手机即可独立使用，采用安卓系统官方 WebView 标准内核展示网页并检测未读消息角标，不篡改平台通信协议、不自动群发消息。

                3. 平台单端登录防封建议
                闲鱼、淘宝千牛、拼多多、抖店、小红书、BOSS直聘等风控严格的平台，请固定只在「手机」或「电脑」其中一端登录网页，切勿两端同时登录同一账号以免互踢或触发风控；登录国内平台请关闭海外代理（VPN）。

                4. 必要权限与最小联网说明
                点击「同意并继续」前，本软件不初始化浏览器内核、不发起任何联网请求。同意后，软件仅申请「通知权限」（用于来消息或海外远程任务完成时向您响铃弹窗）与可选「后台保活」。
            """.trimIndent()
        }
        scroll.addView(bodyTv)
        card.addView(scroll)

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }

        val declineBtn = makeToolbarPill("不同意退出", "#1E293B", "#94A3B8").apply {
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(11), dp(12), dp(11))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 0.85f).apply {
                marginEnd = dp(8)
            }
            setOnClickListener { finishAffinity() }
        }
        val acceptBtn = makeToolbarPill("同意并开始使用", "#2563EB", "#FFFFFF").apply {
            gravity = Gravity.CENTER
            setPadding(dp(14), dp(11), dp(14), dp(11))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.35f)
            setOnClickListener {
                TabPulseApp.instance.repository.acceptPrivacyPolicy()
                nativePrivacyGateView?.let { rootFrame.removeView(it) }
                nativePrivacyGateView = null
                ensureWebUiInitialized()
                startServicesAfterConsent()
                val deferred = pendingSharedIntent
                pendingSharedIntent = null
                if (deferred != null) {
                    handleIncomingIntent(deferred)
                }
            }
        }
        btnRow.addView(declineBtn)
        btnRow.addView(acceptBtn)
        card.addView(btnRow)

        outer.addView(card)
        nativePrivacyGateView = outer
        rootFrame.addView(outer)
    }

    private fun startServicesAfterConsent() {
        TabPulseApp.instance.ensureCookiesInitialized()
        val settings = TabPulseApp.instance.repository.getSettings()
        if (settings.guardianEnabled) {
            MonitorForegroundService.start(this)
        }
        TabPulseApp.instance.repository.pollRemoteRelayOnce()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !NotificationHelper.hasNotificationPermission(this)
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (TabPulseApp.instance.repository.getSettings().privacyAccepted) {
            ensureWebUiInitialized()
            handleIncomingIntent(intent)
        } else {
            pendingSharedIntent = intent
        }
    }

    override fun onResume() {
        super.onResume()
        TabPulseApp.instance.monitorPool.hostCallbacks = this
        val settings = TabPulseApp.instance.repository.getSettings()
        if (settings.privacyAccepted) {
            ensureWebUiInitialized()
            pushStateToDashboard()
            if (settings.guardianEnabled && !MonitorForegroundService.isRunning) {
                MonitorForegroundService.start(this)
            }
            TabPulseApp.instance.repository.pollRemoteRelayOnce()
        }
    }

    override fun onPause() {
        super.onPause()
        if (TabPulseApp.instance.repository.getSettings().privacyAccepted) {
            TabPulseApp.instance.monitorPool.snapshotAllCookies()
        }
    }

    override fun onDestroy() {
        TabPulseApp.instance.repository.removeListener(repoListener)
        if (TabPulseApp.instance.monitorPool.hostCallbacks === this) {
            TabPulseApp.instance.monitorPool.hostCallbacks = null
        }
        TabPulseApp.instance.monitorPool.detachFromActivity(activeWatchId)
        runCatching { discoveryWebView?.destroy() }
        runCatching { companionWebView?.destroy() }
        runCatching { dashboardWebView?.destroy() }
        super.onDestroy()
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null || !webUiInitialized) return
        val openWatchId = intent.getStringExtra(NotificationHelper.EXTRA_OPEN_WATCH_ID)
        if (!openWatchId.isNullOrBlank()) {
            intent.removeExtra(NotificationHelper.EXTRA_OPEN_WATCH_ID)
            openPlatformWatch(openWatchId)
            return
        }

        if (intent.action == Intent.ACTION_SEND && intent.type?.startsWith("text/") == true) {
            val sharedText = listOfNotNull(
                intent.getStringExtra(Intent.EXTRA_SUBJECT),
                intent.getStringExtra(Intent.EXTRA_TEXT)
            ).joinToString(" ")
            intent.action = Intent.ACTION_MAIN
            val parsed = UrlHelpers.extractFirstHttpUrl(sharedText)
            if (parsed != null) {
                val (titleHint, url) = parsed
                val (item, isNew) = TabPulseApp.instance.repository.addPlatform(
                    name = titleHint,
                    rawUrl = url,
                    category = "分享添加",
                    group = "custom"
                )
                if (item != null) {
                    toast(if (isNew) "✅ 已通过系统分享添加「${item.name}」" else "已打开「${item.name}」")
                    openPlatformWatch(item.id)
                }
            } else if (sharedText.isNotBlank()) {
                openDiscoveryOverlay(sharedText.trim().take(24))
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureWebUiInitialized() {
        if (webUiInitialized) return
        webUiInitialized = true

        // 1. Local Dashboard WebView (created ONLY after privacy consent!)
        val dash = WebView(this).apply {
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
        dashboardWebView = dash
        rootFrame.addView(dash)

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

        riskBanner = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#451A03"))
            setPadding(dp(11), dp(7), dp(9), dp(7))
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        riskBanner.addView(TextView(this).apply {
            setTextColor(Color.parseColor("#FDE68A"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.8f)
            text = "⚠️ 防互踢防封提醒：此类平台请固定只在「手机」或「电脑」单端登网页，切勿两头同时登同一号；登国内号请关掉海外 VPN！"
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        riskBanner.addView(makeToolbarPill("知道了", "#92400E", "#FEF3C7").apply {
            setOnClickListener {
                riskBanner.visibility = View.GONE
                activeWatchId?.let { TabPulseApp.instance.repository.dismissRiskBanner(it) }
            }
        })
        platformOverlay.addView(riskBanner)

        platformWebContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }
        platformOverlay.addView(platformWebContainer)

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

        externalBanner.addView(makeToolbarPill("允许打开", "#2563EB", "#FFFFFF").apply {
            setOnClickListener {
                val url = pendingExternalUrl
                externalBanner.visibility = View.GONE
                pendingExternalUrl = null
                if (!url.isNullOrBlank()) {
                    launchExternalUri(url)
                }
            }
        })
        externalBanner.addView(makeToolbarPill("忽略", "#334155", "#CBD5E1").apply {
            setOnClickListener {
                externalBanner.visibility = View.GONE
                pendingExternalUrl = null
            }
        })
        platformOverlay.addView(externalBanner)
        rootFrame.addView(platformOverlay)

        // 3. Zero-URL Search-to-Add Discovery Overlay
        discoveryOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0B1120"))
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        val discBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#111827"))
            setPadding(dp(8), dp(6), dp(8), dp(6))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52))
        }
        discBar.addView(makeToolbarPill("← 取消", "#1E293B", "#F8FAFC").apply {
            setOnClickListener { closeDiscoveryOverlay() }
        })
        discoveryTitleTv = TextView(this).apply {
            text = "点进官网后，点右侧蓝按钮即可"
            setTextColor(Color.parseColor("#E2E8F0"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(8), 0, dp(6), 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        discBar.addView(discoveryTitleTv)
        discBar.addView(makeToolbarPill("⭐ 就守这个页面", "#2563EB", "#FFFFFF").apply {
            setOnClickListener { captureDiscoveryCurrentPage() }
        })
        discoveryOverlay.addView(discBar)

        discoveryProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(3))
        }
        discoveryOverlay.addView(discoveryProgress)
        rootFrame.addView(discoveryOverlay)

        // 4. Optional Advanced Companion Overlay
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
        compBar.addView(makeToolbarPill("← 返回", "#1E293B", "#F8FAFC").apply {
            setOnClickListener { closeCompanionOverlay() }
        })
        compBar.addView(TextView(this).apply {
            text = "🖥️ 远程面板"
            setTextColor(Color.parseColor("#F8FAFC"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(10), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        compBar.addView(makeToolbarPill("↻ 刷新", "#1E293B", "#E2E8F0").apply {
            setOnClickListener { companionWebView?.reload() }
        })
        companionOverlay.addView(compBar)
        rootFrame.addView(companionOverlay)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun openDiscoveryOverlay(keyword: String) {
        val cleanKw = keyword.trim()
        if (cleanKw.isBlank()) {
            toast("请先输入你想找的平台名字（比如 转转、猪八戒）")
            return
        }
        discoveryKeywordHint = cleanKw
        TabPulseApp.instance.ensureCookiesInitialized()

        var wv = discoveryWebView
        if (wv == null) {
            wv = WebView(this).apply {
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.databaseEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = true
                settings.javaScriptCanOpenWindowsAutomatically = true
                settings.setSupportMultipleWindows(true)
                settings.useWideViewPort = true
                settings.loadWithOverviewMode = true
                settings.setSupportZoom(true)
                settings.builtInZoomControls = true
                settings.displayZoomControls = false
                settings.userAgentString = BackgroundMonitorPool.DESKTOP_CHROME_UA
                runCatching {
                    CookieManager.getInstance().setAcceptCookie(true)
                    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                        val u = request?.url ?: return false
                        val scheme = u.scheme?.lowercase().orEmpty()
                        return !(scheme == "http" || scheme == "https")
                    }

                    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                        discoveryProgress.visibility = View.VISIBLE
                    }

                    override fun onPageFinished(view: WebView?, url: String?) {
                        discoveryProgress.visibility = View.GONE
                        val u = url.orEmpty()
                        if (u.isNotBlank() && !UrlHelpers.isSearchEnginePage(u)) {
                            discoveryTitleTv.text = "已进网站！点右侧「⭐ 就守这个页面」"
                        }
                    }
                }
                webChromeClient = object : WebChromeClient() {
                    override fun onCreateWindow(
                        view: WebView?,
                        isDialog: Boolean,
                        isUserGesture: Boolean,
                        resultMsg: android.os.Message?
                    ): Boolean {
                        val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                        val tempWv = WebView(this@MainActivity)
                        tempWv.webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(v: WebView?, req: WebResourceRequest?): Boolean {
                                val target = req?.url?.toString().orEmpty()
                                if (target.startsWith("http://") || target.startsWith("https://")) {
                                    view?.loadUrl(target)
                                }
                                runCatching { v?.destroy() }
                                return true
                            }
                            override fun onPageStarted(v: WebView?, url: String?, favicon: Bitmap?) {
                                if (!url.isNullOrBlank() && (url.startsWith("http://") || url.startsWith("https://"))) {
                                    view?.loadUrl(url)
                                    runCatching { v?.destroy() }
                                }
                            }
                        }
                        transport.webView = tempWv
                        resultMsg.sendToTarget()
                        return true
                    }
                }
            }
            discoveryWebView = wv
            discoveryOverlay.addView(wv)
        }

        discoveryTitleTv.text = "点进「$cleanKw」官网 → 点右侧收藏"
        val searchUrl = UrlHelpers.buildSearchOfficialUrl(cleanKw)
        wv.loadUrl(searchUrl)
        discoveryOverlay.visibility = View.VISIBLE
        platformOverlay.visibility = View.GONE
        companionOverlay.visibility = View.GONE
    }

    private fun captureDiscoveryCurrentPage() {
        val wv = discoveryWebView ?: return
        val curUrl = wv.url.orEmpty()
        if (curUrl.isBlank() || UrlHelpers.isSearchEnginePage(curUrl)) {
            toast("请先在搜索结果里点进官方网站，再点右上角「⭐ 就守这个页面」！")
            return
        }
        TabPulseApp.instance.cookieVault.snapshotForUrl(curUrl)
        val cleanName = UrlHelpers.cleanCapturedPageTitle(wv.title, curUrl)
            .ifBlank { discoveryKeywordHint }

        val (item, _) = TabPulseApp.instance.repository.addPlatform(
            name = cleanName,
            rawUrl = curUrl,
            category = "常用平台",
            group = "custom",
            desktopUa = true
        )
        if (item == null) {
            toast("当前页面无法添加，请进入具体网站后再试")
            return
        }
        closeDiscoveryOverlay()
        if (TabPulseApp.instance.repository.getSettings().guardianEnabled) {
            MonitorForegroundService.start(this)
        }
        toast("✅ 已收进消息总管：「${item.name}」！")
        openPlatformWatch(item.id)
    }

    private fun closeDiscoveryOverlay() {
        discoveryOverlay.visibility = View.GONE
        discoveryWebView?.loadUrl("about:blank")
        pushStateToDashboard()
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
        if (!webUiInitialized) return
        TabPulseApp.instance.ensureCookiesInitialized()
        val repo = TabPulseApp.instance.repository
        val watch = repo.getWatch(watchId) ?: run {
            toast("该平台不存在或已删除")
            return
        }
        if (activeWatchId != null && activeWatchId != watchId) {
            TabPulseApp.instance.monitorPool.detachFromActivity(activeWatchId)
        }
        activeWatchId = watchId
        pendingExternalUrl = null
        externalBanner.visibility = View.GONE

        val showRisk = UrlHelpers.isHighRiskSingleEndPlatform(watch.name, watch.url) &&
            !repo.getSettings().dismissedRiskIds.contains(watch.id)
        riskBanner.visibility = if (showRisk) View.VISIBLE else View.GONE

        platformTitleTv.text = watch.name
        updateUaButton(watch.desktopUa)
        refreshPlatformToolbarBadge()

        TabPulseApp.instance.monitorPool.attachToContainer(watch, this, platformWebContainer)
        platformOverlay.visibility = View.VISIBLE
        discoveryOverlay.visibility = View.GONE
        companionOverlay.visibility = View.GONE
        pushStateToDashboard()
    }

    private fun closePlatformOverlay(snapshotCookies: Boolean = true) {
        if (!webUiInitialized) return
        val wid = activeWatchId
        activeWatchId = null
        pendingExternalUrl = null
        externalBanner.visibility = View.GONE
        riskBanner.visibility = View.GONE
        platformWebContainer.removeAllViews()
        TabPulseApp.instance.monitorPool.detachFromActivity(wid, snapshotCookies = snapshotCookies)
        platformOverlay.visibility = View.GONE
        pushStateToDashboard()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun openCompanionOverlay(rawUrl: String) {
        if (!webUiInitialized) return
        val clean = UrlHelpers.normalizeHttpUrl(rawUrl)
        if (clean == null) {
            toast("请输入正确的远程面板链接（https://...）")
            return
        }
        TabPulseApp.instance.ensureCookiesInitialized()
        TabPulseApp.instance.repository.updateSettings { it.copy(companionUrl = clean) }
        var cwv = companionWebView
        if (cwv == null) {
            cwv = WebView(this).apply {
                setBackgroundColor(Color.parseColor("#0B1120"))
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.databaseEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = true
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
                        runCatching { CookieManager.getInstance().flush() }
                    }
                }
            }
            companionWebView = cwv
            companionOverlay.addView(cwv)
        }
        cwv.loadUrl(clean)
        companionOverlay.visibility = View.VISIBLE
        platformOverlay.visibility = View.GONE
        discoveryOverlay.visibility = View.GONE
    }

    private fun closeCompanionOverlay() {
        if (!webUiInitialized) return
        companionOverlay.visibility = View.GONE
        pushStateToDashboard()
    }

    private fun updateUaButton(desktopUa: Boolean) {
        platformUaBtn.text = if (desktopUa) "💻电脑" else "📱手机"
    }

    private fun refreshPlatformToolbarBadge() {
        if (!webUiInitialized) return
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
                val curUrl = TabPulseApp.instance.monitorPool.getCurrentUrl(watch.id)
                if (activeWatchId == watch.id) closePlatformOverlay(snapshotCookies = false)
                TabPulseApp.instance.monitorPool.destroyWatchView(watch.id, clearCache = true)
                TabPulseApp.instance.repository.unbindWatch(watch.id, extraUrl = curUrl)
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
                val curUrl = TabPulseApp.instance.monitorPool.getCurrentUrl(watch.id)
                if (activeWatchId == watch.id) closePlatformOverlay(snapshotCookies = false)
                TabPulseApp.instance.monitorPool.destroyWatchView(watch.id, clearCache = true)
                TabPulseApp.instance.repository.removeWatch(watch.id, extraUrl = curUrl)
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
                Intent.parseUri(rawUrl, Intent.URI_INTENT_SCHEME).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    component = null
                    selector = null
                }
            } else {
                Intent(Intent.ACTION_VIEW, Uri.parse(rawUrl)).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                }
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
        val dash = dashboardWebView ?: return
        if (!dashboardReady) return
        val app = TabPulseApp.instance
        val stateJson = app.repository.buildStateJson(
            guardianRunning = MonitorForegroundService.isRunning,
            notificationsGranted = NotificationHelper.hasNotificationPermission(this),
            batteryWhitelisted = NotificationHelper.isIgnoringBatteryOptimizations(this)
        )
        val escaped = JSONObject.quote(stateJson)
        dash.post {
            dash.evaluateJavascript(
                "if (window.__onAppState) window.__onAppState(JSON.parse($escaped));",
                null
            )
        }
    }

    override fun onPageTitleChanged(watchId: String, title: String) {
        if (webUiInitialized && activeWatchId == watchId && title.isNotBlank()) {
            val watch = TabPulseApp.instance.repository.getWatch(watchId)
            platformTitleTv.text = watch?.name ?: title
        }
    }

    override fun onPageLoadingChanged(watchId: String, loading: Boolean, currentUrl: String) {
        if (webUiInitialized && activeWatchId == watchId) {
            platformProgress.visibility = if (loading) View.VISIBLE else View.GONE
        }
    }

    override fun onExternalSchemeRequested(watchId: String, externalUrl: String) {
        if (!webUiInitialized || activeWatchId != watchId) return
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
        fun acceptPrivacy() {
            TabPulseApp.instance.repository.acceptPrivacyPolicy()
            runOnUiThread {
                ensureWebUiInitialized()
                startServicesAfterConsent()
                pushStateToDashboard()
            }
        }

        @JavascriptInterface
        fun exitApp() {
            runOnUiThread { finishAffinity() }
        }

        @JavascriptInterface
        fun openSearchDiscovery(keyword: String) {
            runOnUiThread { openDiscoveryOverlay(keyword) }
        }

        @JavascriptInterface
        fun peekClipboardUrl(): String {
            val out = JSONObject().apply { put("found", false) }
            runCatching {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                val raw = cm?.primaryClip?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString().orEmpty()
                val parsed = UrlHelpers.extractFirstHttpUrl(raw)
                if (parsed != null) {
                    val (titleHint, url) = parsed
                    val cmp = UrlHelpers.canonicalCompareKey(url)
                    val already = TabPulseApp.instance.repository.getWatches()
                        .any { UrlHelpers.canonicalCompareKey(it.url) == cmp }
                    if (!already) {
                        out.put("found", true)
                        out.put("title", titleHint)
                        out.put("url", url)
                    }
                }
            }
            return out.toString()
        }

        @JavascriptInterface
        fun copyText(text: String, toastMsg: String) {
            runOnUiThread {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("tabpulse", text))
                toast(toastMsg.ifBlank { "已复制到剪贴板" })
            }
        }

        @JavascriptInterface
        fun resetRelayToken(): String {
            val tok = TabPulseApp.instance.repository.resetRelayToken()
            toast("已更换全新的海外通知通道码")
            return tok
        }

        @JavascriptInterface
        fun testRemoteRelayPush() {
            if (!NotificationHelper.hasNotificationPermission(this@MainActivity)) {
                runOnUiThread {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        openAppNotificationSettings()
                    }
                }
                return
            }
            toast("正在模拟 CC 笼子发送完工通知…")
            TabPulseApp.instance.repository.sendSelfTestRelayPing { ok ->
                toast(if (ok) "🎉 模拟成功！请看手机顶部弹窗提醒" else "连接云端超时，请检查手机网络后重试")
            }
        }

        @JavascriptInterface
        fun sendCcCommand(prompt: String) {
            val clean = prompt.trim()
            if (clean.isEmpty()) {
                toast("请先输入要发给 CC 的指令")
                return
            }
            TabPulseApp.instance.repository.sendRemoteCommandToCc(clean) { ok ->
                toast(
                    if (ok) "📤 已投递给 CC！笼子里的 cc-remote 收到后会立即开工并在完工后弹窗通知你"
                    else "发送失败，请检查手机网络后重试"
                )
            }
        }

        @JavascriptInterface
        fun addCatalogPlatform(platformId: String): String {
            val (item, isNew) = TabPulseApp.instance.repository.addFromCatalog(platformId)
            if (item != null && TabPulseApp.instance.repository.getSettings().guardianEnabled) {
                runOnUiThread {
                    MonitorForegroundService.start(this@MainActivity)
                }
            }
            return JSONObject().apply {
                put("ok", item != null)
                put("created", isNew)
                put("id", item?.id ?: "")
                put("name", item?.name ?: "")
                put("highRisk", item != null && UrlHelpers.isHighRiskSingleEndPlatform(item.name, item.url))
            }.toString()
        }

        @JavascriptInterface
        fun addCustomPlatform(name: String, rawUrl: String, desktopUa: Boolean): String {
            val (item, isNew) = TabPulseApp.instance.repository.addPlatform(
                name = name,
                rawUrl = rawUrl,
                category = "常用平台",
                group = "custom",
                loginHint = "打开页面登录，自动持久保持",
                desktopUa = desktopUa,
                allowDuplicate = false
            )
            if (item != null && TabPulseApp.instance.repository.getSettings().guardianEnabled) {
                runOnUiThread {
                    MonitorForegroundService.start(this@MainActivity)
                }
            }
            return JSONObject().apply {
                put("ok", item != null)
                put("created", isNew)
                put("id", item?.id ?: "")
                put("error", if (item == null) "没认出网址，建议直接用上方「输中文名字搜官网」！" else "")
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
                        relayEnabled = obj.optBoolean("relayEnabled", cur.relayEnabled),
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
            TabPulseApp.instance.repository.pollRemoteRelayOnce()
            toast("正在刷新全部平台与远程通知…")
        }
    }
}

package com.opc.tabpulse

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.MutableContextWrapper
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.util.concurrent.ConcurrentHashMap

interface PlatformWebHostCallbacks {
    fun onPageTitleChanged(watchId: String, title: String)
    fun onPageLoadingChanged(watchId: String, loading: Boolean, currentUrl: String)
    fun onExternalSchemeRequested(watchId: String, externalUrl: String)
    fun onShowFileChooser(
        watchId: String,
        filePathCallback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams
    ): Boolean
}

/**
 * Application-scoped pool of live WebViews that stay warm in background while
 * MonitorForegroundService runs, and seamlessly reparent into MainActivity with zero reload.
 */
class BackgroundMonitorPool(
    private val appContext: Context,
    private val repository: WatchRepository,
    private val cookieVault: SessionCookieVault
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val liveViews = LinkedHashMap<String, WebView>()
    private val currentUrls = ConcurrentHashMap<String, String>()
    private val passiveObserverScript: String by lazy {
        runCatching {
            appContext.assets.open("passive-observer.js").bufferedReader().use { it.readText() }
        }.getOrDefault("")
    }

    @Volatile
    var attachedWatchId: String? = null
        private set

    @Volatile
    var hostCallbacks: PlatformWebHostCallbacks? = null

    private var overflowRotateCursor = 0

    fun getOrCreateWebView(watch: WatchItem, activityContext: Context? = null): WebView {
        check(Looper.myLooper() == Looper.getMainLooper()) { "Must be called on main thread" }
        val existing = liveViews[watch.id]
        if (existing != null) {
            // Touch LRU order
            liveViews.remove(watch.id)
            liveViews[watch.id] = existing
            return existing
        }

        evictIfNeeded(watch.id)
        cookieVault.restoreForUrl(watch.url)

        val ctxWrapper = MutableContextWrapper(activityContext ?: appContext)
        val wv = createConfiguredWebView(ctxWrapper, watch)
        liveViews[watch.id] = wv
        currentUrls[watch.id] = watch.url
        wv.loadUrl(watch.url)
        return wv
    }

    fun attachToContainer(watch: WatchItem, activity: Activity, container: ViewGroup): WebView {
        val wv = getOrCreateWebView(watch, activity)
        detachViewFromParent(wv)
        (wv.context as? MutableContextWrapper)?.baseContext = activity
        container.removeAllViews()
        container.addView(
            wv,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        wv.onResume()
        wv.resumeTimers()
        attachedWatchId = watch.id
        repository.markWatchOpened(watch.id)
        return wv
    }

    fun detachFromActivity(watchId: String?, snapshotCookies: Boolean = true) {
        val id = watchId ?: attachedWatchId ?: return
        val wv = liveViews[id]
        if (wv != null) {
            detachViewFromParent(wv)
            (wv.context as? MutableContextWrapper)?.baseContext = appContext
            if (snapshotCookies) {
                cookieVault.snapshotForUrl(currentUrls[id] ?: repository.getWatch(id)?.url.orEmpty())
            }
            // Keep WebView alive for background passive monitoring
            wv.onResume()
        }
        if (attachedWatchId == id) {
            attachedWatchId = null
        }
    }

    fun reloadWatch(watchId: String, resetToHome: Boolean = false) {
        mainHandler.post {
            val watch = repository.getWatch(watchId) ?: return@post
            val wv = liveViews[watchId] ?: return@post
            applyUserAgent(wv, watch.desktopUa)
            if (resetToHome) {
                wv.loadUrl(watch.url)
            } else {
                wv.reload()
            }
        }
    }

    fun getCurrentUrl(watchId: String): String {
        return currentUrls[watchId] ?: repository.getWatch(watchId)?.url.orEmpty()
    }

    fun destroyWatchView(watchId: String, clearCache: Boolean = false) {
        val task = Runnable {
            val wv = liveViews.remove(watchId) ?: return@Runnable
            currentUrls.remove(watchId)
            if (attachedWatchId == watchId) attachedWatchId = null
            detachViewFromParent(wv)
            (wv.context as? MutableContextWrapper)?.baseContext = appContext
            runCatching {
                wv.stopLoading()
                if (clearCache) {
                    wv.clearCache(true)
                    wv.clearFormData()
                    wv.clearHistory()
                }
                wv.loadUrl("about:blank")
                wv.destroy()
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            task.run()
        } else {
            mainHandler.post(task)
        }
    }

    /**
     * Ensures logged-in watches stay warmed up in background and cycles overflow watches gently.
     * Skips explicitly unbound / auth_expired or never-opened idle watches so they never resurrect.
     */
    fun warmUpWatches(runKeepAlivePing: Boolean = false) {
        mainHandler.post {
            val watches = repository.getWatches().filter { w ->
                w.id == attachedWatchId ||
                    w.status == "ok" ||
                    w.status == "unread" ||
                    (w.status == "idle" && cookieVault.hasSavedSession(w.url))
            }
            if (watches.isEmpty()) return@post
            val limit = repository.getSettings().maxLiveTabs.coerceIn(2, 8)

            val toWarm = if (watches.size <= limit) {
                watches
            } else {
                val selected = ArrayList<WatchItem>()
                attachedWatchId?.let { aid ->
                    watches.firstOrNull { it.id == aid }?.let { selected.add(it) }
                }
                val startIdx = overflowRotateCursor % watches.size
                for (offset in watches.indices) {
                    if (selected.size >= limit) break
                    val candidate = watches[(startIdx + offset) % watches.size]
                    if (selected.none { it.id == candidate.id }) {
                        selected.add(candidate)
                    }
                }
                overflowRotateCursor = (overflowRotateCursor + 1) % watches.size
                selected
            }

            for (w in toWarm) {
                val wv = getOrCreateWebView(w)
                injectPassiveObserver(wv)
                if (runKeepAlivePing && !repository.isQuietHourNow(repository.getSettings().nightQuietEnabled)) {
                    runCatching {
                        wv.evaluateJavascript(
                            "if (window.__TABPULSE_KEEPALIVE_PING__) window.__TABPULSE_KEEPALIVE_PING__();",
                            null
                        )
                    }
                }
                cookieVault.snapshotForUrl(currentUrls[w.id] ?: w.url)
            }
        }
    }

    fun snapshotAllCookies() {
        mainHandler.post {
            for (w in repository.getWatches()) {
                if (w.status == "auth_expired") continue
                if (liveViews.containsKey(w.id)) {
                    cookieVault.snapshotForUrl(currentUrls[w.id] ?: w.url)
                }
            }
            runCatching { CookieManager.getInstance().flush() }
        }
    }

    fun trimInactiveViews() {
        mainHandler.post {
            val keys = liveViews.keys.toList()
            for (id in keys) {
                if (id != attachedWatchId && liveViews.size > 2) {
                    destroyWatchView(id, clearCache = false)
                }
            }
        }
    }

    private fun evictIfNeeded(incomingId: String) {
        val limit = repository.getSettings().maxLiveTabs.coerceIn(2, 8)
        while (liveViews.size >= limit) {
            val victimKey = liveViews.keys.firstOrNull { it != attachedWatchId && it != incomingId } ?: break
            val victim = liveViews.remove(victimKey) ?: break
            currentUrls.remove(victimKey)
            detachViewFromParent(victim)
            (victim.context as? MutableContextWrapper)?.baseContext = appContext
            runCatching {
                victim.stopLoading()
                victim.loadUrl("about:blank")
                victim.destroy()
            }
        }
    }

    private fun detachViewFromParent(wv: WebView) {
        val parent = wv.parent as? ViewGroup
        parent?.removeView(wv)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createConfiguredWebView(context: Context, watch: WatchItem): WebView {
        val wv = WebView(context)
        val watchId = watch.id

        val settings = wv.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.mediaPlaybackRequiresUserGesture = true
        settings.setSupportZoom(true)
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.setSupportMultipleWindows(true)
        settings.allowFileAccess = false
        settings.allowContentAccess = true
        applyUserAgent(wv, watch.desktopUa)

        runCatching {
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setAcceptThirdPartyCookies(wv, true)
        }

        wv.addJavascriptInterface(PassiveJsBridge(watchId), "TabPulseAndroid")

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                val scheme = uri.scheme?.lowercase().orEmpty()
                if (scheme == "http" || scheme == "https" || scheme == "about" || scheme == "blob" || scheme == "data") {
                    return false
                }
                // Intercept app-hijack / OAuth external app schemes cleanly without breaking page
                val raw = uri.toString()
                if (attachedWatchId == watchId) {
                    mainHandler.post {
                        hostCallbacks?.onExternalSchemeRequested(watchId, raw)
                    }
                }
                return true
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                if (!url.isNullOrBlank()) {
                    currentUrls[watchId] = url
                }
                if (attachedWatchId == watchId) {
                    mainHandler.post {
                        hostCallbacks?.onPageLoadingChanged(watchId, true, url.orEmpty())
                    }
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                val finalUrl = url.orEmpty()
                if (finalUrl.isNotBlank() && finalUrl != "about:blank") {
                    currentUrls[watchId] = finalUrl
                    cookieVault.snapshotForUrl(finalUrl)
                    repository.getWatch(watchId)?.let { cookieVault.snapshotForUrl(it.url) }
                }
                if (view != null) {
                    injectPassiveObserver(view)
                }
                if (attachedWatchId == watchId) {
                    mainHandler.post {
                        hostCallbacks?.onPageLoadingChanged(watchId, false, finalUrl)
                    }
                }
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView?, title: String?) {
                super.onReceivedTitle(view, title)
                if (!title.isNullOrBlank() && attachedWatchId == watchId) {
                    mainHandler.post {
                        hostCallbacks?.onPageTitleChanged(watchId, title)
                    }
                }
            }

            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?
            ): Boolean {
                // Redirect target="_blank" / login popup cleanly into the same WebView
                val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                val tempWv = WebView(appContext)
                tempWv.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView?, req: WebResourceRequest?): Boolean {
                        val u = req?.url?.toString().orEmpty()
                        if (u.startsWith("http://") || u.startsWith("https://")) {
                            view?.loadUrl(u)
                        } else if (u.isNotBlank() && attachedWatchId == watchId) {
                            mainHandler.post { hostCallbacks?.onExternalSchemeRequested(watchId, u) }
                        }
                        runCatching { v?.destroy() }
                        return true
                    }

                    override fun onPageStarted(v: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
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

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                if (filePathCallback == null || fileChooserParams == null) return false
                val cb = hostCallbacks ?: return false
                return cb.onShowFileChooser(watchId, filePathCallback, fileChooserParams)
            }

            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                if (attachedWatchId != watchId) {
                    result?.confirm()
                    return true
                }
                return super.onJsAlert(view, url, message, result)
            }

            override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                if (attachedWatchId != watchId) {
                    result?.cancel()
                    return true
                }
                return super.onJsConfirm(view, url, message, result)
            }

            override fun onJsPrompt(
                view: WebView?,
                url: String?,
                message: String?,
                defaultValue: String?,
                result: JsPromptResult?
            ): Boolean {
                if (attachedWatchId != watchId) {
                    result?.cancel()
                    return true
                }
                return super.onJsPrompt(view, url, message, defaultValue, result)
            }
        }

        // Pre-measure & layout offscreen WebView so passive-observer.js getBoundingClientRect() works even in background!
        val offscreenW = if (watch.desktopUa) 1280 else 390
        val offscreenH = if (watch.desktopUa) 900 else 844
        wv.measure(
            View.MeasureSpec.makeMeasureSpec(offscreenW, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(offscreenH, View.MeasureSpec.EXACTLY)
        )
        wv.layout(0, 0, offscreenW, offscreenH)

        return wv
    }

    private fun applyUserAgent(wv: WebView, desktop: Boolean) {
        wv.settings.userAgentString = if (desktop) DESKTOP_CHROME_UA else MOBILE_CHROME_UA
        wv.settings.useWideViewPort = desktop
        wv.settings.loadWithOverviewMode = desktop
    }

    private fun injectPassiveObserver(wv: WebView) {
        if (passiveObserverScript.isBlank()) return
        runCatching {
            wv.evaluateJavascript(passiveObserverScript, null)
        }
    }

    inner class PassiveJsBridge(private val watchId: String) {
        @JavascriptInterface
        fun onPassiveEvent(rawJson: String) {
            val evt = PassiveEvent.fromJsonString(rawJson) ?: return
            repository.handlePassiveEvent(watchId, evt)
        }
    }

    companion object {
        // Realistic modern Chrome UAs WITHOUT "; wv)" so sites do not block WebView login!
        const val DESKTOP_CHROME_UA =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        const val MOBILE_CHROME_UA =
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
    }
}

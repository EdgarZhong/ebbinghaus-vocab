package com.edgarzhong.ebbinghaus

import android.os.Bundle
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlin.math.ceil

class MainActivity : TauriActivity() {
  @Volatile private var statusInsetCssPx = 0
  @Volatile private var navigationInsetCssPx = 0
  private var appWebView: WebView? = null

  // 桥接仅传递系统栏尺寸与当前已生效的主题，不经桥接传递凭据或业务数据。
  // WebView 的 JavaScript 桥在后台线程回调，系统栏外观必须切回主线程更新。
  private inner class SafeAreaBridge {
    @JavascriptInterface
    fun getStatusInsetCssPx(): Int = statusInsetCssPx

    @JavascriptInterface
    fun getNavigationInsetCssPx(): Int = navigationInsetCssPx

    @JavascriptInterface
    fun setResolvedTheme(theme: String) {
      if (theme != "light" && theme != "dark") return
      runOnUiThread {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = theme == "light"
        controller.isAppearanceLightNavigationBars = theme == "light"
      }
    }
  }

  private val applySafeAreaScript = """
    (function () {
      function apply() {
        var root = document.documentElement;
        if (root) {
          root.style.setProperty('--android-status-inset',
            window.__ebbinghausAndroidSafeArea.getStatusInsetCssPx() + 'px');
          root.style.setProperty('--android-nav-inset',
            window.__ebbinghausAndroidSafeArea.getNavigationInsetCssPx() + 'px');
        }
      }

      function installThemeObserver() {
        var root = document.documentElement;
        if (!root) return false;
        apply();
        function syncTheme() {
          var theme = root.getAttribute('data-theme');
          if (theme === 'light' || theme === 'dark') {
            window.__ebbinghausAndroidSafeArea.setResolvedTheme(theme);
          }
        }
        if (!window.__ebbinghausAndroidThemeObserverInstalled) {
          window.__ebbinghausAndroidThemeObserverInstalled = true;
          new MutationObserver(syncTheme).observe(root,
            { attributes: true, attributeFilter: ['data-theme'] });
        }
        syncTheme();
        return true;
      }

      if (!installThemeObserver()) {
        // document-start 可早于 <html> 创建；尽早发现根元素，覆盖首帧前的主题脚本。
        var rootObserver = new MutationObserver(function () {
          if (installThemeObserver()) rootObserver.disconnect();
        });
        rootObserver.observe(document, { childList: true });
      }
    })();
  """.trimIndent()

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    // 只有独立 debug 验收包开放 Chromium DevTools，使 Appium 能读取 Tauri WebView 的 DOM；
    // 正式构建不启用该入口，避免把页面调试能力暴露给正式安装。
    if (BuildConfig.DEBUG) {
      WebView.setWebContentsDebuggingEnabled(true)
    }
    webView.addJavascriptInterface(SafeAreaBridge(), "__ebbinghausAndroidSafeArea")

    // 文档启动脚本覆盖冷启动、重载与 data-theme 变化；Insets 回调更新当前文档。
    // 源规则匹配 Tauri 本地页及 WebView 错误页；桥接仅能读取尺寸或切换系统栏图标。
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      WebViewCompat.addDocumentStartJavaScript(
        webView,
        applySafeAreaScript,
        setOf("*")
      )
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 三键导航的系统对比遮罩会把森色背板盖成灰条；背板仍全屏绘制，
    // 只按真实导航栏高度给抽屉里的底部控件留出触控空间。
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isNavigationBarContrastEnforced = false
    }

    // WebView 保持全屏绘制：森色页面和顶栏的毛玻璃背景需延伸到透明状态栏及导航栏后方。
    // 仅在软键盘出现时缩短底部可交互区域，不把导航栏高度变成常驻空白。
    val content = findViewById<ViewGroup>(android.R.id.content)
    val originalBottom = content.paddingBottom
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val status = insets.getInsets(
        WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = resources.displayMetrics.density
      val nextStatusInsetCssPx = ceil(status.top / density).toInt()
      val navigation = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
      val nextNavigationInsetCssPx = ceil(navigation.bottom / density).toInt()
      if (statusInsetCssPx != nextStatusInsetCssPx ||
        navigationInsetCssPx != nextNavigationInsetCssPx) {
        statusInsetCssPx = nextStatusInsetCssPx
        navigationInsetCssPx = nextNavigationInsetCssPx
        appWebView?.post { appWebView?.evaluateJavascript(applySafeAreaScript, null) }
      }

      val keyboardBottom = if (insets.isVisible(WindowInsetsCompat.Type.ime())) {
        insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      } else {
        0
      }
      view.updatePadding(bottom = originalBottom + keyboardBottom)
      insets
    }
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    ViewCompat.requestApplyInsets(content)
  }

  override fun onDestroy() {
    appWebView = null
    super.onDestroy()
  }
}

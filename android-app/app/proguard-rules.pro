# Keep JavascriptInterface bridges intact under R8 minification
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.opc.tabpulse.MainActivity$AppUiBridge { *; }
-keep class com.opc.tabpulse.BackgroundMonitorPool$PassiveJsBridge { *; }

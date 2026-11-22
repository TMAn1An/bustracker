# Methods called from the website's JavaScript (window.AndroidBridge)
-keepclassmembers class io.github.tman1an.bustracker.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}

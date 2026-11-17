package com.adfree.yttv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * Full-screen WebView running YouTube's TV interface (youtube.com/tv) in guest
 * mode, with ads removed in three layers:
 *   1. Network: requests to ad/tracking servers are answered with an empty response.
 *   2. Data: ad entries are stripped from YouTube's JSON before the player sees them
 *      (injected script, see assets/adblock.js).
 *   3. Fallback: if an ad still plays, the script skips it instantly.
 */
public class MainActivity extends Activity {

    static final String TAG = "AdFreeTV";
    private static final String HOME_URL = "https://www.youtube.com/tv";

    private WebView web;
    private Rules rules;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Rules: last downloaded copy (or built-in defaults); refresh in background.
        rules = Rules.load(this);
        RuleUpdater.refreshInBackground(this);
        // Signed updates of the ad-block script / user agent / app (over Wi-Fi).
        Updater.checkInBackground(this);

        web = new WebView(this);
        web.setBackgroundColor(0xFF000000);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        setContentView(web);
        hideSystemUi();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        String ua = Updater.userAgentOverride(this);
        s.setUserAgentString(ua != null ? ua : rules.userAgent);

        CookieManager.getInstance().setAcceptCookie(true);

        // Voice search bridge: lets YouTube's mic button use the TV's speech recognizer.
        web.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void start() {
                runOnUiThread(MainActivity.this::startVoiceSearch);
            }
        }, "AdFreeVoice");

        final boolean docStart = injectAdBlockScript();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap favicon) {
                // Older WebView without document-start scripts: inject as early as possible.
                if (!docStart && url != null && url.startsWith("https://www.youtube.com")) {
                    v.evaluateJavascript(adBlockScript, null);
                }
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (rules.isBlocked(u)) {
                    return emptyResponse();
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // Stay inside YouTube; ignore links that try to leave it.
                String host = req.getUrl().getHost();
                return host == null || !(host.endsWith("youtube.com") || host.endsWith("google.com"));
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (m.message() != null && m.message().startsWith("[AdFreeTV]")) {
                    Log.i(TAG, m.message());
                }
                return true;
            }

            @Override
            public void onCloseWindow(WebView window) {
                // YouTube's own "Exit app?" dialog calls window.close().
                finish();
            }
        });

        boolean debuggable = (getApplicationInfo().flags
                & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            // Test builds only: allow inspecting the page from the Mac.
            WebView.setWebContentsDebuggingEnabled(true);
        }

        String testUrl = debuggable ? getIntent().getStringExtra("url") : null;
        if (testUrl != null && testUrl.startsWith("https://www.youtube.com/")) {
            web.loadUrl(testUrl);
        } else if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(HOME_URL);
        }
        web.requestFocus();
    }

    private String adBlockScript;

    /** @return true if the script runs at document start (before YouTube's own code). */
    private boolean injectAdBlockScript() {
        String remote = Updater.cachedScript(this); // signed update, if any
        adBlockScript = "window.__ADFREE_RULES=" + rules.toScriptJson() + ";\n"
                + (remote != null ? remote : Rules.readAsset(this, "adblock.js"));
        Log.i(TAG, "Using " + (remote != null ? "updated" : "built-in") + " ad-block script");
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Set<String> origins = new HashSet<>(Collections.singletonList("https://www.youtube.com"));
            WebViewCompat.addDocumentStartJavaScript(web, adBlockScript, origins);
            Log.i(TAG, "Ad-block script installed at document start");
            return true;
        }
        Log.w(TAG, "DOCUMENT_START_SCRIPT unsupported; using onPageStarted fallback");
        return false;
    }

    private static WebResourceResponse emptyResponse() {
        return new WebResourceResponse("text/plain", "utf-8", 204, "No Content",
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    // ---- Voice search ------------------------------------------------------

    private static final int VOICE_REQUEST = 4242;

    /** Opens the TV's speech prompt ("Speak now"), using the remote's microphone. */
    void startVoiceSearch() {
        android.content.Intent i = new android.content.Intent(
                android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                        android.speech.RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
                .putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Search YouTube")
                .putExtra(android.speech.RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        try {
            startActivityForResult(i, VOICE_REQUEST);
        } catch (android.content.ActivityNotFoundException e) {
            Log.w(TAG, "No speech recognizer on this device");
            android.widget.Toast.makeText(this, "Voice search isn't available on this TV",
                    android.widget.Toast.LENGTH_LONG).show();
            web.evaluateJavascript("window.__adfreeVoiceEnd && window.__adfreeVoiceEnd()", null);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != VOICE_REQUEST) return;
        java.util.ArrayList<String> results = data == null ? null
                : data.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS);
        if (resultCode == RESULT_OK && results != null && !results.isEmpty()) {
            String q = org.json.JSONObject.quote(results.get(0));
            web.evaluateJavascript("window.__adfreeVoiceResult && window.__adfreeVoiceResult(" + q + ")", null);
        } else {
            web.evaluateJavascript("window.__adfreeVoiceEnd && window.__adfreeVoiceEnd()", null);
        }
    }

    private static boolean isVoiceKey(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_SEARCH
                || keyCode == KeyEvent.KEYCODE_VOICE_ASSIST
                || keyCode == KeyEvent.KEYCODE_ASSIST;
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Remote's mic / search button -> voice search inside AdFree TV.
        if (isVoiceKey(event.getKeyCode())) {
            if (event.getAction() == KeyEvent.ACTION_UP) startVoiceSearch();
            return true;
        }
        // The remote's Back button: let YouTube's TV UI handle it as its "back" key
        // (Escape). YouTube shows its own "exit?" dialog at the top level.
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            // Hold Back (about 1 second) to exit the app straight away.
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() >= 10) {
                backHeld = true;
                finish();
                return true;
            }
            if (event.getAction() == KeyEvent.ACTION_UP) {
                if (backHeld) {
                    backHeld = false;
                    return true;
                }
                web.evaluateJavascript(
                        "(function(){var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true};"
                                + "var t=document.activeElement||document.body;"
                                + "t.dispatchEvent(new KeyboardEvent('keydown',o));"
                                + "t.dispatchEvent(new KeyboardEvent('keyup',o));})()", null);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private boolean backHeld;

    private void hideSystemUi() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemUi();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}

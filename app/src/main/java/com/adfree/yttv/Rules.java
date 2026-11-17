package com.adfree.yttv;

import android.content.Context;
import android.net.Uri;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Ad-blocking rules: built-in defaults merged with the last list downloaded by
 * {@link RuleUpdater}. The built-in defaults are always applied, so the app
 * blocks ads even offline or on first launch.
 */
final class Rules {

    static final String FILE = "rules.json";

    /** YouTube's TV interface is only served to TV browsers. */
    static final String DEFAULT_USER_AGENT =
            "Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 "
                    + "LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)";

    /** JSON keys holding ads in YouTube's data (player, next, browse responses). */
    static final List<String> DEFAULT_AD_KEYS = Arrays.asList(
            "adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams",
            "adBreakParams", "adParams", "no_ads");

    /** Ad / tracking servers that are always blocked. */
    static final List<String> DEFAULT_BLOCKED_HOSTS = Arrays.asList(
            "doubleclick.net", "googleadservices.com", "googlesyndication.com",
            "adservice.google.com", "imasdk.googleapis.com", "2mdn.net",
            "ads.youtube.com", "google-analytics.com");

    /** Ad endpoints on YouTube's own domain. */
    static final List<String> BLOCKED_YT_PATHS = Arrays.asList(
            "/api/stats/ads", "/pagead/", "/ptracking", "/get_midroll_info",
            "/youtubei/v1/player/ad_break", "/api/stats/atr");

    /** Never block these from downloaded lists: YouTube itself needs them. */
    static final List<String> NEVER_BLOCK = Arrays.asList(
            "youtube.com", "googlevideo.com", "ytimg.com", "ggpht.com", "google.com",
            "gstatic.com", "googleapis.com", "youtube-nocookie.com", "googleusercontent.com");

    final String userAgent;
    final Set<String> adKeys = new HashSet<>(DEFAULT_AD_KEYS);
    final Set<String> listHosts = new HashSet<>();
    final long updatedAt;

    private Rules(String userAgent, long updatedAt) {
        this.userAgent = userAgent;
        this.updatedAt = updatedAt;
    }

    static Rules load(Context ctx) {
        File f = new File(ctx.getFilesDir(), FILE);
        if (f.exists()) {
            try (InputStream in = new FileInputStream(f)) {
                JSONObject o = new JSONObject(readAll(in));
                Rules r = new Rules(o.optString("userAgent", DEFAULT_USER_AGENT), o.optLong("updatedAt"));
                addAll(r.adKeys, o.optJSONArray("adKeys"));
                addAll(r.listHosts, o.optJSONArray("hosts"));
                Log.i(MainActivity.TAG, "Rules loaded: " + r.adKeys.size() + " ad keys, "
                        + r.listHosts.size() + " list hosts, updatedAt=" + r.updatedAt);
                return r;
            } catch (Exception e) {
                Log.w(MainActivity.TAG, "Saved rules unreadable, using defaults", e);
            }
        }
        return new Rules(DEFAULT_USER_AGENT, 0);
    }

    boolean isBlocked(Uri u) {
        String host = u.getHost();
        if (host == null) return false;
        host = host.toLowerCase();

        if (host.endsWith("youtube.com")) {
            String path = u.getPath();
            if (path != null) {
                for (String p : BLOCKED_YT_PATHS) if (path.startsWith(p)) return true;
            }
        }
        if (matchesSuffix(host, DEFAULT_BLOCKED_HOSTS)) return true;
        if (matchesSuffix(host, NEVER_BLOCK)) return false;

        // Downloaded list: check the host and each parent domain.
        String h = host;
        while (true) {
            if (listHosts.contains(h)) return true;
            int dot = h.indexOf('.');
            if (dot < 0 || h.indexOf('.', dot + 1) < 0) return false;
            h = h.substring(dot + 1);
        }
    }

    private static boolean matchesSuffix(String host, List<String> domains) {
        for (String d : domains) {
            if (host.equals(d) || host.endsWith("." + d)) return true;
        }
        return false;
    }

    /** The part of the rules the injected page script needs. */
    String toScriptJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("adKeys", new JSONArray(adKeys));
            return o.toString();
        } catch (Exception e) {
            return "{\"adKeys\":[]}";
        }
    }

    static String readAsset(Context ctx, String name) {
        try (InputStream in = ctx.getAssets().open(name)) {
            return readAll(in);
        } catch (Exception e) {
            throw new IllegalStateException("Missing asset " + name, e);
        }
    }

    static String readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static void addAll(Set<String> into, JSONArray a) {
        if (a == null) return;
        for (int i = 0; i < a.length(); i++) {
            String s = a.optString(i, null);
            if (s != null && !s.isEmpty()) into.add(s);
        }
    }

    static Set<String> emptySet() {
        return Collections.emptySet();
    }
}

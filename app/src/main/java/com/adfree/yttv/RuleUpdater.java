package com.adfree.yttv;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Downloads the public, community-maintained filter lists (the same ones
 * uBlock Origin and Brave use) and keeps a local copy. Runs in the background
 * at most every few hours; new rules apply from the next launch. If a download
 * fails, the previous copy (or the built-in defaults) keeps working.
 */
final class RuleUpdater {

    private static final long MAX_AGE_MS = 6L * 60 * 60 * 1000; // 6 hours

    /** uBlock Origin's main lists: contain the YouTube ad rules ("json-prune"). */
    private static final String[] UBO_LISTS = {
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
            "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt",
    };

    /** Peter Lowe's ad-server list: one domain per line. */
    private static final String HOSTS_LIST =
            "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext";

    /** `youtube.com##+js(json-prune..., <paths>, ...)` */
    private static final Pattern SCRIPTLET =
            Pattern.compile("##\\+js\\(\\s*([\\w.-]*json-prune[\\w-]*)\\s*,\\s*([^,)]+)");

    /** Only accept key names that clearly refer to ads, so a bad list can't break YouTube. */
    private static final Pattern AD_KEY = Pattern.compile(
            "^ad[A-Z]\\w*$|^ads?$|^no_ads$|^\\w*[a-z_]Ads?([A-Z]\\w*)?$|^\\w*[Pp]romo\\w*$|^\\w*[Ss]ponsor\\w*$");

    private static final Pattern DOMAIN = Pattern.compile("^[a-z0-9.-]+\\.[a-z]{2,}$");

    static void refreshInBackground(Context ctx) {
        final Context app = ctx.getApplicationContext();
        Rules current = Rules.load(app);
        if (System.currentTimeMillis() - current.updatedAt < MAX_AGE_MS) return;
        new Thread(() -> {
            try {
                update(app, current);
            } catch (Exception e) {
                Log.w(MainActivity.TAG, "Rule update failed; keeping previous rules", e);
            }
        }, "rule-updater").start();
    }

    private static void update(Context ctx, Rules current) throws Exception {
        Set<String> adKeys = new LinkedHashSet<>();
        int scriptletRules = 0;
        for (String url : UBO_LISTS) {
            String text = download(url);
            for (String line : text.split("\n")) {
                if (line.startsWith("!")) continue; // comment / disabled rule
                int sep = line.indexOf("##+js(");
                if (sep <= 0 || !line.substring(0, sep).contains("youtube")) continue;
                Matcher m = SCRIPTLET.matcher(line);
                if (!m.find()) continue;
                scriptletRules++;
                for (String path : m.group(2).trim().split("\\s+")) {
                    String key = lastSegment(path);
                    if (AD_KEY.matcher(key).matches()) adKeys.add(key);
                }
            }
        }

        Set<String> hosts = new LinkedHashSet<>();
        for (String line : download(HOSTS_LIST).split("\n")) {
            String h = line.trim().toLowerCase();
            if (DOMAIN.matcher(h).matches()) hosts.add(h);
        }

        // Sanity check: if the lists look broken, keep what we have.
        if (scriptletRules == 0 && hosts.size() < 100) {
            Log.w(MainActivity.TAG, "Downloaded lists look empty; keeping previous rules");
            return;
        }

        JSONObject o = new JSONObject();
        o.put("updatedAt", System.currentTimeMillis());
        o.put("userAgent", current.userAgent);
        o.put("adKeys", new JSONArray(adKeys));
        o.put("hosts", new JSONArray(hosts));

        File tmp = new File(ctx.getFilesDir(), Rules.FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(o.toString().getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(new File(ctx.getFilesDir(), Rules.FILE))) {
            throw new IllegalStateException("Could not save rules");
        }
        Log.i(MainActivity.TAG, "Rules updated: " + scriptletRules + " YouTube rules -> "
                + adKeys.size() + " ad keys " + adKeys + ", " + hosts.size() + " ad hosts");
    }

    /** "[].playerResponse.adPlacements" -> "adPlacements" */
    static String lastSegment(String path) {
        String p = path.replace("[]", "").replace("[-]", "");
        int dot = p.lastIndexOf('.');
        String k = dot >= 0 ? p.substring(dot + 1) : p;
        return k.replaceAll("[^A-Za-z0-9_]", "");
    }

    private static String download(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(20000);
        c.setRequestProperty("User-Agent", "AdFreeTV-RuleUpdater");
        try (InputStream in = c.getInputStream()) {
            if (c.getResponseCode() != 200) throw new IllegalStateException(url + " -> " + c.getResponseCode());
            return Rules.readAll(in);
        } finally {
            c.disconnect();
        }
    }
}

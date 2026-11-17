package com.adfree.yttv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;

/**
 * Self-update over Wi-Fi, with nobody at home:
 *  - ad-block script + TV user agent: downloaded and applied silently (next launch);
 *  - the app itself: downloaded silently; Android then asks once "Install update?"
 *    (sideloaded apps can't replace themselves without that one confirmation).
 *
 * Everything is checked against a signed manifest. Only updates signed with the
 * private key on the owner's Mac are accepted.
 */
final class Updater {

    /** Where updates are published (owner's GitHub repository). */
    static final String BASE = "https://raw.githubusercontent.com/prashanth-k-1/adfree-yt-tv/main/update/";

    /** Public half of the update-signing key (ECDSA P-256). */
    private static final String PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEu2wbfkmq+4j8ZJiAnXNrHoA3/Qcho3NqcUOW+KLn960cdIW3LMYQbhiUHdAzZV0iUcQ9syxR34adXf6NHtuAuw==";

    private static final long CHECK_EVERY_MS = 6L * 60 * 60 * 1000;
    static final String SCRIPT_FILE = "adblock-remote.js";
    static final String APK_FILE = "update.apk";

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("updater", Context.MODE_PRIVATE);
    }

    /** Remote script if a verified one was downloaded, else null (use built-in). */
    static String cachedScript(Context c) {
        File f = new File(c.getFilesDir(), SCRIPT_FILE);
        if (!f.exists()) return null;
        try (InputStream in = new java.io.FileInputStream(f)) {
            return Rules.readAll(in);
        } catch (Exception e) {
            return null;
        }
    }

    static String userAgentOverride(Context c) {
        return prefs(c).getString("userAgent", null);
    }

    static void checkInBackground(Activity a) {
        Context app = a.getApplicationContext();
        SharedPreferences p = prefs(app);
        if (System.currentTimeMillis() - p.getLong("lastCheck", 0) < CHECK_EVERY_MS) {
            offerPendingApk(a);
            return;
        }
        new Thread(() -> {
            try {
                check(app);
                p.edit().putLong("lastCheck", System.currentTimeMillis()).apply();
            } catch (Exception e) {
                Log.w(MainActivity.TAG, "Update check failed (will retry later): " + e.getMessage());
            }
            a.runOnUiThread(() -> offerPendingApk(a));
        }, "updater").start();
    }

    private static void check(Context c) throws Exception {
        byte[] manifestBytes = download(BASE + "manifest.json");
        byte[] sig = Base64.decode(new String(download(BASE + "manifest.json.sig"), StandardCharsets.US_ASCII).trim(), Base64.DEFAULT);
        if (!verify(manifestBytes, sig)) {
            Log.w(MainActivity.TAG, "Update manifest signature INVALID - ignoring");
            return;
        }
        JSONObject m = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
        SharedPreferences p = prefs(c);

        String ua = m.optString("userAgent", "");
        if (!ua.isEmpty()) p.edit().putString("userAgent", ua).apply();

        int scriptVersion = m.optInt("scriptVersion", 0);
        if (scriptVersion > p.getInt("scriptVersion", 0)) {
            byte[] js = download(BASE + "adblock.js");
            if (sha256(js).equalsIgnoreCase(m.getString("scriptSha256"))) {
                writeAtomic(new File(c.getFilesDir(), SCRIPT_FILE), js);
                p.edit().putInt("scriptVersion", scriptVersion).apply();
                Log.i(MainActivity.TAG, "Ad-block script updated to v" + scriptVersion);
            } else {
                Log.w(MainActivity.TAG, "Script hash mismatch - ignoring");
            }
        }

        int apkVersion = m.optInt("apkVersionCode", 0);
        if (apkVersion > BuildConfig.VERSION_CODE && apkVersion > p.getInt("apkReady", 0)) {
            byte[] apk = download(BASE + "app.apk");
            if (sha256(apk).equalsIgnoreCase(m.getString("apkSha256"))) {
                writeAtomic(new File(c.getCacheDir(), APK_FILE), apk);
                p.edit().putInt("apkReady", apkVersion).apply();
                Log.i(MainActivity.TAG, "App update v" + apkVersion + " downloaded");
            } else {
                Log.w(MainActivity.TAG, "APK hash mismatch - ignoring");
            }
        }
    }

    /** If a verified newer app was downloaded, show Android's install screen once per launch. */
    static void offerPendingApk(Activity a) {
        int ready = prefs(a).getInt("apkReady", 0);
        File apk = new File(a.getCacheDir(), APK_FILE);
        if (ready <= BuildConfig.VERSION_CODE || !apk.exists()) {
            if (apk.exists() && ready <= BuildConfig.VERSION_CODE) apk.delete();
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(a, a.getPackageName() + ".files", apk);
            Intent i = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !a.getPackageManager().canRequestPackageInstalls()) {
                // First time only: Android asks to allow this app to install updates.
                a.startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + a.getPackageName())));
                return;
            }
            a.startActivity(i);
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "Could not open installer", e);
        }
    }

    static boolean verify(byte[] data, byte[] sig) {
        try {
            PublicKey key = KeyFactory.getInstance("EC").generatePublic(
                    new X509EncodedKeySpec(Base64.decode(PUBLIC_KEY, Base64.DEFAULT)));
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(key);
            s.update(data);
            return s.verify(sig);
        } catch (Exception e) {
            return false;
        }
    }

    static String sha256(byte[] data) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static void writeAtomic(File target, byte[] data) throws Exception {
        File tmp = new File(target.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
        }
        if (!tmp.renameTo(target)) throw new IllegalStateException("rename failed");
    }

    private static byte[] download(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(60000);
        c.setUseCaches(false);
        try (InputStream in = c.getInputStream()) {
            if (c.getResponseCode() != 200) throw new IllegalStateException(url + " -> " + c.getResponseCode());
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            c.disconnect();
        }
    }
}

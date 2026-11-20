package com.skuuulline.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/**
 * Spoken bus alerts. Android ties a notification's sound to its channel, and a channel's sound can never change,
 * so every published voice version gets its own channels: v_<clip>_<lang>_<rev>.
 * install() downloads each clip, saves it where the system can play it, creates the channel with that sound,
 * and removes the channels (and sound files) of any other voice version.
 */
@CapacitorPlugin(name = "VoiceChannels")
public class VoiceChannelsPlugin extends Plugin {

    private static final String PREFIX = "v_";
    private static final String PREFS = "voice_channels";

    @PluginMethod
    public void install(PluginCall call) {
        JSArray channels = call.getArray("channels");
        if (channels == null) {
            call.reject("No channels");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // No channels before Android 8: alerts play the normal sound.
            call.reject("Android 8 or newer needed for spoken alerts");
            return;
        }
        new Thread(() -> {
            try {
                Context ctx = getContext();
                NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                Set<String> wanted = new HashSet<>();
                int created = 0;
                for (int i = 0; i < channels.length(); i++) {
                    JSONObject c = channels.getJSONObject(i);
                    String id = c.getString("id");
                    String name = c.optString("name", id);
                    String url = c.getString("url");
                    if (!id.startsWith(PREFIX)) continue;
                    wanted.add(id);
                    if (nm.getNotificationChannel(id) != null) continue;
                    byte[] bytes = download(url);
                    String ext = url.toLowerCase().endsWith(".mp3") ? "mp3" : url.toLowerCase().endsWith(".ogg") ? "ogg" : "wav";
                    Uri sound = saveSound(ctx, id, name, ext, bytes);
                    NotificationChannel ch = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
                    ch.setDescription("Spoken school bus alert");
                    ch.enableVibration(true);
                    ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                    ch.setSound(
                        sound,
                        new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build()
                    );
                    nm.createNotificationChannel(ch);
                    prefs.edit().putString(id, sound.toString()).apply();
                    created++;
                }
                // Drop every other voice version's channels and their sound files.
                int removed = 0;
                List<NotificationChannel> all = nm.getNotificationChannels();
                for (NotificationChannel ch : all) {
                    String id = ch.getId();
                    if (id.startsWith(PREFIX) && !wanted.contains(id)) {
                        nm.deleteNotificationChannel(id);
                        String uri = prefs.getString(id, null);
                        if (uri != null) {
                            deleteSound(ctx, Uri.parse(uri));
                            prefs.edit().remove(id).apply();
                        }
                        removed++;
                    }
                }
                JSObject ret = new JSObject();
                ret.put("created", created);
                ret.put("removed", removed);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }).start();
    }

    private static byte[] download(String url) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setConnectTimeout(20000);
        con.setReadTimeout(30000);
        try {
            if (con.getResponseCode() != 200) throw new Exception("Download failed (" + con.getResponseCode() + ")");
            try (InputStream in = con.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toByteArray();
            }
        } finally {
            con.disconnect();
        }
    }

    /** Android 10+: the shared Notifications sounds folder (the system can always play these). Older: app files + FileProvider grant. */
    private static Uri saveSound(Context ctx, String id, String title, String ext, byte[] bytes) throws Exception {
        String mime = ext.equals("mp3") ? "audio/mpeg" : ext.equals("ogg") ? "audio/ogg" : "audio/wav";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver r = ctx.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.Audio.Media.DISPLAY_NAME, "skuuulline_" + id + "." + ext);
            v.put(MediaStore.Audio.Media.TITLE, "Skuuul-Line " + title);
            v.put(MediaStore.Audio.Media.MIME_TYPE, mime);
            v.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_NOTIFICATIONS + "/Skuuul-Line Pro");
            v.put(MediaStore.Audio.Media.IS_NOTIFICATION, 1);
            v.put(MediaStore.Audio.Media.IS_PENDING, 1);
            Uri uri = r.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
            if (uri == null) throw new Exception("Could not save the sound");
            try (OutputStream out = r.openOutputStream(uri)) {
                if (out == null) throw new Exception("Could not write the sound");
                out.write(bytes);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Audio.Media.IS_PENDING, 0);
            r.update(uri, done, null, null);
            return uri;
        }
        File dir = new File(ctx.getFilesDir(), "voice");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("Could not create the sound folder");
        File f = new File(dir, id + "." + ext);
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(bytes);
        }
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
        ctx.grantUriPermission("com.android.systemui", uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ctx.grantUriPermission("android", uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return uri;
    }

    private static void deleteSound(Context ctx, Uri uri) {
        try {
            if ("file".equals(uri.getScheme())) return;
            if (uri.getAuthority() != null && uri.getAuthority().endsWith(".fileprovider")) {
                File f = new File(new File(ctx.getFilesDir(), "voice"), uri.getLastPathSegment());
                //noinspection ResultOfMethodCallIgnored
                f.delete();
                return;
            }
            ctx.getContentResolver().delete(uri, null, null);
        } catch (Exception ignored) {
            // the file may already be gone
        }
    }
}

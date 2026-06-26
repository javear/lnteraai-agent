package com.lntera.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.util.Arrays;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Native streaming HTTP for the WebView. The Android WebView's fetch can buffer streamed responses;
 * OkHttp streams chunks as they arrive. The JS side (web/src/lib/native-fetch.ts) drives this via a
 * `fetch`-shaped shim plugged into the Mastra SDK, so the SDK parses the stream exactly as on web —
 * we only swap the transport. Chunks are relayed (base64) over a single "streamHttp" event, keyed by id.
 */
@CapacitorPlugin(name = "StreamHttp")
public class StreamHttpPlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // no read timeout — chat streams stay open
        .build();

    private final ConcurrentHashMap<String, Call> calls = new ConcurrentHashMap<>();

    @PluginMethod
    public void start(PluginCall call) {
        final String id = call.getString("id");
        final String url = call.getString("url");
        final String method = call.getString("method", "POST");
        final String body = call.getString("body", null);
        final JSObject headers = call.getObject("headers");

        if (id == null || url == null) {
            call.reject("id and url are required");
            return;
        }

        Request.Builder rb = new Request.Builder().url(url);
        String contentType = "application/json";
        if (headers != null) {
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                String v = headers.getString(k);
                if (v != null) {
                    rb.header(k, v);
                    if (k.equalsIgnoreCase("content-type")) contentType = v;
                }
            }
        }

        RequestBody reqBody = null;
        if (body != null) {
            reqBody = RequestBody.create(body.getBytes(), MediaType.parse(contentType));
        }
        try {
            rb.method(method, reqBody);
        } catch (Exception e) {
            call.reject("invalid request: " + e.getMessage());
            return;
        }

        final Call httpCall = client.newCall(rb.build());
        calls.put(id, httpCall);
        call.resolve(); // resolve immediately; the body streams via events

        new Thread(() -> {
            try (Response response = httpCall.execute()) {
                JSObject open = new JSObject();
                open.put("id", id);
                open.put("type", "open");
                open.put("status", response.code());
                notifyListeners("streamHttp", open);

                ResponseBody rbody = response.body();
                if (rbody != null) {
                    InputStream in = rbody.byteStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        if (n > 0) {
                            byte[] slice = (n == buf.length) ? buf : Arrays.copyOf(buf, n);
                            JSObject data = new JSObject();
                            data.put("id", id);
                            data.put("type", "data");
                            data.put("chunk", Base64.encodeToString(slice, Base64.NO_WRAP));
                            notifyListeners("streamHttp", data);
                        }
                    }
                }

                JSObject end = new JSObject();
                end.put("id", id);
                end.put("type", "end");
                notifyListeners("streamHttp", end);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("id", id);
                err.put("type", "error");
                err.put("message", e.getMessage() == null ? "stream error" : e.getMessage());
                notifyListeners("streamHttp", err);
            } finally {
                calls.remove(id);
            }
        }).start();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id != null) {
            Call c = calls.remove(id);
            if (c != null) c.cancel();
        }
        call.resolve();
    }
}

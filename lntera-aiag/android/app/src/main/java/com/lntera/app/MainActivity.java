package com.lntera.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Native streaming HTTP bridge (smooth chat streaming, bypassing WebView fetch buffering).
        registerPlugin(StreamHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

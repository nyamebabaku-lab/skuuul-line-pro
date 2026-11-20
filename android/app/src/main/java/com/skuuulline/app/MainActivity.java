package com.skuuulline.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceChannelsPlugin.class); // spoken bus alerts (Record Studio voices)
        super.onCreate(savedInstanceState);
    }
}

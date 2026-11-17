package app.deepcompanion.shell;

import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.widget.Button;
import android.widget.FrameLayout;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

public class MainActivity extends BridgeActivity {
    private static final String PREFS = "d_shell";

    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        String baked = BuildConfig.TRIAL_ORIGIN == null ? "" : BuildConfig.TRIAL_ORIGIN.trim();
        if (!baked.isEmpty()) {
            OriginPolicy locked = OriginPolicy.parse(baked, false);
            if (locked.ok) {
                this.config = new CapConfig.Builder(this)
                    .setServerUrl(locked.origin)
                    .setAllowMixedContent(false)
                    .create();
            }
            super.onCreate(savedInstanceState);
            if (bridge == null || bridge.getWebView() == null) return;
            CookieManager cookies = CookieManager.getInstance();
            cookies.setAcceptCookie(true);
            cookies.setAcceptThirdPartyCookies(bridge.getWebView(), false);
            return;
        }
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        boolean showSetup = prefs.getBoolean("show_setup", true);
        String saved = prefs.getString("origin", "");
        OriginPolicy decision = OriginPolicy.parse(saved, BuildConfig.DEBUG);
        if (!decision.ok && saved != null && !saved.isEmpty()) {
            prefs.edit().remove("origin").putBoolean("show_setup", true).apply();
            showSetup = true;
        }
        if (!showSetup && decision.ok) {
            this.config = new CapConfig.Builder(this)
                .setServerUrl(decision.origin)
                .setAllowMixedContent(false)
                .create();
        }
        super.onCreate(savedInstanceState);
        if (bridge == null || bridge.getWebView() == null) return;
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(bridge.getWebView(), false);
        if (config == null || config.getServerUrl() == null) {
            bridge.getWebView().addJavascriptInterface(new ShellJs(), "DShell");
        } else {
            addOriginButton();
        }
    }

    private void addOriginButton() {
        ViewGroup content = findViewById(android.R.id.content);
        if (content == null) return;
        Button button = new Button(this);
        button.setText("地址");
        button.setAllCaps(false);
        float density = getResources().getDisplayMetrics().density;
        button.setMinHeight((int) (44 * density));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP | Gravity.END
        );
        int margin = (int) (12 * density);
        params.setMargins(margin, (int) (48 * density), margin, margin);
        button.setOnClickListener(view -> {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("show_setup", true).apply();
            recreate();
        });
        content.addView(button, params);
    }

    private final class ShellJs {
        @android.webkit.JavascriptInterface
        public boolean isDebug() {
            return BuildConfig.DEBUG;
        }

        @android.webkit.JavascriptInterface
        public String getOrigin() {
            return getSharedPreferences(PREFS, MODE_PRIVATE).getString("origin", "");
        }

        @android.webkit.JavascriptInterface
        public String getVersion() {
            try {
                PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
                return info.versionName + " (" + PackageInfoCompat.getLongVersionCode(info) + ")";
            } catch (Exception ex) {
                return "0.1.0-debug";
            }
        }

        @android.webkit.JavascriptInterface
        public String setOrigin(String raw) {
            OriginPolicy decision = OriginPolicy.parse(raw, BuildConfig.DEBUG);
            if (!decision.ok) return decision.reason;
            runOnUiThread(() -> {
                SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                String previous = prefs.getString("origin", "");
                if (!decision.origin.equals(previous)) {
                    CookieManager manager = CookieManager.getInstance();
                    manager.removeAllCookies(null);
                    manager.flush();
                }
                prefs.edit().putString("origin", decision.origin).putBoolean("show_setup", false).apply();
                recreate();
            });
            return "";
        }

        @android.webkit.JavascriptInterface
        public void clearCookies() {
            CookieManager manager = CookieManager.getInstance();
            manager.removeAllCookies(null);
            manager.flush();
        }
    }
}

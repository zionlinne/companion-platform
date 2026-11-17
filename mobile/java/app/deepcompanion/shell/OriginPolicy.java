package app.deepcompanion.shell;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.Set;

public final class OriginPolicy {
    private static final Set<String> DEBUG_HTTP_HOSTS = Set.of("127.0.0.1", "localhost", "::1", "[::1]", "10.0.2.2");

    public final boolean ok;
    public final String origin;
    public final String transport;
    public final String reason;

    private OriginPolicy(boolean ok, String origin, String transport, String reason) {
        this.ok = ok;
        this.origin = origin;
        this.transport = transport;
        this.reason = reason;
    }

    public static OriginPolicy parse(String raw, boolean debug) {
        String text = raw == null ? "" : raw.strip();
        if (text.isEmpty()) return fail("请填写服务地址");
        URI uri;
        try {
            uri = new URI(text);
        } catch (URISyntaxException ex) {
            return fail("地址不是合法 URL");
        }
        if (uri.getRawUserInfo() != null) return fail("地址不能包含用户名或密码");
        if (uri.getRawQuery() != null || uri.getRawFragment() != null) return fail("地址不能带查询或片段");
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return fail("只接受 HTTPS");
        String path = uri.getPath();
        if (path != null && !path.isEmpty() && !path.equals("/")) return fail("请只填写源，不要带路径");
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return fail("缺少主机名");
        host = host.toLowerCase(Locale.ROOT);
        if (scheme.equals("https")) return ok(origin(scheme, host, uri.getPort()), "https");
        if (!debug) return fail("正式包只接受 HTTPS");
        if (!DEBUG_HTTP_HOSTS.contains(host)) return fail("调试 HTTP 只允许本机回环或模拟器 10.0.2.2");
        return ok(origin(scheme, host, uri.getPort()), "debug-http");
    }

    private static String origin(String scheme, String host, int port) {
        if ((scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80)) port = -1;
        String rendered = host.contains(":") && !(host.startsWith("[") && host.endsWith("]")) ? "[" + host + "]" : host;
        return scheme + "://" + rendered + (port == -1 ? "" : ":" + port);
    }

    private static OriginPolicy ok(String origin, String transport) {
        return new OriginPolicy(true, origin, transport, "");
    }

    private static OriginPolicy fail(String reason) {
        return new OriginPolicy(false, "", "", reason);
    }
}

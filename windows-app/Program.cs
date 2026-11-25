using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace TabPulseWin;

internal static class WinPowerKeeper
{
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint esFlags);

    private const uint ES_CONTINUOUS = 0x80000000;
    private const uint ES_SYSTEM_REQUIRED = 0x00000001;

    public static void ApplyPreventSleep(bool enable)
    {
        try
        {
            SetThreadExecutionState(enable ? (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) : ES_CONTINUOUS);
        }
        catch { }
    }
}

internal static class LicenseCheck
{
    private const string PubKeyHex = "7953c20694277c090b5a4d3e7544a478223fa1bad98c5d1ff0dd6ca6a1f00244";

    private static byte[] Base64UrlDecode(string s)
    {
        var pad = s.Replace('-', '+').Replace('_', '/');
        switch (pad.Length % 4)
        {
            case 2: pad += "=="; break;
            case 3: pad += "="; break;
        }
        return Convert.FromBase64String(pad);
    }

    public static JsonObject Verify(string rawKey)
    {
        var parts = (rawKey ?? "").Trim().Split('.');
        if (parts.Length != 3 || parts[0] != "TP1")
            return new JsonObject { ["valid"] = false, ["plan"] = "free", ["error"] = "Invalid key format" };
        try
        {
            var payloadBytes = Base64UrlDecode(parts[1]);
            var sigBytes = Base64UrlDecode(parts[2]);
            var pubBytes = Convert.FromHexString(PubKeyHex);
            var signer = new Ed25519Signer();
            signer.Init(false, new Ed25519PublicKeyParameters(pubBytes, 0));
            signer.BlockUpdate(payloadBytes, 0, payloadBytes.Length);
            if (!signer.VerifySignature(sigBytes))
                return new JsonObject { ["valid"] = false, ["plan"] = "free", ["error"] = "Signature invalid" };

            var node = JsonNode.Parse(Encoding.UTF8.GetString(payloadBytes))?.AsObject();
            var plan = node?["p"]?.GetValue<string>() ?? "lifetime";
            var exp = node?["e"]?.GetValue<string>();
            if (!string.IsNullOrEmpty(exp) && DateTime.TryParse(exp, out var expDt) && expDt < DateTime.UtcNow.AddDays(-1))
                return new JsonObject { ["valid"] = false, ["plan"] = "free", ["expired"] = true, ["error"] = $"Expired {exp}" };

            return new JsonObject
            {
                ["valid"] = true,
                ["plan"] = plan,
                ["serial"] = node?["s"]?.GetValue<string>() ?? ""
            };
        }
        catch
        {
            return new JsonObject { ["valid"] = false, ["plan"] = "free", ["error"] = "Malformed license" };
        }
    }
}

internal static class PushTargetHelper
{
    public static (string url, string kind, string token) Normalize(string rawInput)
    {
        var trimmed = (rawInput ?? "").Trim();
        if (string.IsNullOrEmpty(trimmed)) return ("", "none", "");

        if (Regex.IsMatch(trimmed, "^[a-fA-F0-9]{32}$"))
            return ("https://www.pushplus.plus/send", "pushplus", trimmed);

        if (Regex.IsMatch(trimmed, "^SCT[a-zA-Z0-9]{10,64}$"))
            return ($"https://sctapi.ftqq.com/{trimmed}.send", "serverchan", trimmed);

        if (Regex.IsMatch(trimmed, "^[A-Za-z0-9]{20,28}$") && !trimmed.StartsWith("TP1"))
            return ($"https://api.day.app/{trimmed}", "bark", trimmed);

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https"))
            return ("", "invalid", "");

        var host = uri.Host.ToLowerInvariant();
        if (host == "localhost" || host == "0.0.0.0" || host == "::1" || host.EndsWith(".local") ||
            host.StartsWith("127.") || host.StartsWith("10.") || host.StartsWith("192.168.") || host.StartsWith("169.254."))
            return ("", "invalid", "");
        if (host.Contains("pushplus.plus")) return (trimmed, "pushplus_url", "");
        if (host.Contains("sctapi.ftqq.com")) return (trimmed, "serverchan", "");
        if (host.Contains("api.day.app")) return (trimmed.TrimEnd('/'), "bark", "");
        if (host.Contains("feishu.cn") || host.Contains("larksuite.com")) return (trimmed, "feishu", "");
        if (host.Contains("qyapi.weixin.qq.com")) return (trimmed, "wecom", "");
        if (host.Contains("oapi.dingtalk.com")) return (trimmed, "dingtalk", "");
        if (host.Contains("discord.com") && trimmed.Contains("/api/webhooks/")) return (trimmed, "discord", "");
        return (trimmed, "webhook", "");
    }
}

internal sealed class MainDashboardForm : Form
{
    private readonly WebView2 _dashboard = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon _tray;
    private readonly bool _isZh = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.Equals("zh", StringComparison.OrdinalIgnoreCase);
    private readonly string _appRoot;
    private readonly string _stateFile;
    private readonly Dictionary<string, Form> _workspaceForms = new();
    private readonly Dictionary<string, WebView2> _workspaceWebViews = new();
    private TcpListener? _mobileListener;
    private int _mobilePort = 17890;
    private bool _boundLanMode;
    private readonly Dictionary<string, (int count, DateTime lastAt)> _failedAuthByIp = new();
    private Process? _sshTunnelProc;
    private string _publicTunnelUrl = "";
    private string _tunnelStatus = "stopped";
    private bool _wantedTunnel;
    private const string EdgeGatewayOrigin = "https://replyradar-edge.a3152557994.workers.dev";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(6) };

    public MainDashboardForm()
    {
        _appRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TabPulse");
        Directory.CreateDirectory(Path.Combine(_appRoot, "profiles"));
        _stateFile = Path.Combine(_appRoot, "state.json");

        Text = _isZh ? "消息总管 — 多平台消息看护与多开防串号工作台 (v5.5.0)" : "ReplyRadar — Multi-Account Unread Inbox & Lead Radar (v5.5.0)";
        Width = 1240;
        Height = 820;
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_dashboard);

        var menu = new ContextMenuStrip();
        menu.Items.Add(_isZh ? "打开消息总管主窗口" : "Open ReplyRadar", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add(_isZh ? "彻底退出" : "Quit", null, (_, _) => { _tray!.Visible = false; Environment.Exit(0); });

        _tray = new NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Information,
            Text = _isZh ? "消息总管 · 静默看护中" : "ReplyRadar · Active",
            ContextMenuStrip = menu,
            Visible = true
        };
        _tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };

        FormClosing += (_, e) =>
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
            }
        };

        Shown += async (_, _) => await InitWebViewAsync();
    }

    private async Task<bool> IsLocalHubAliveAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(650));
            var resp = await Http.GetAsync("http://127.0.0.1:17890/api/health", cts.Token);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private async Task InitWebViewAsync()
    {
        var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_appRoot, "dashboard-webview"));
        await _dashboard.EnsureCoreWebView2Async(env);
        var hubAlive = await IsLocalHubAliveAsync();
        await _dashboard.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
            hubAlive ? "window.__TABPULSE_STANDALONE_MODE = false;" : "window.__TABPULSE_STANDALONE_MODE = true;"
        );
        _dashboard.CoreWebView2.WebMessageReceived += async (_, args) => await HandleJsMessageAsync(args.TryGetWebMessageAsString());
        _dashboard.CoreWebView2.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            if (!string.IsNullOrEmpty(args.Uri))
                Process.Start(new ProcessStartInfo(args.Uri) { UseShellExecute = true });
        };

        if (hubAlive)
        {
            _dashboard.CoreWebView2.Navigate("http://127.0.0.1:17890/");
        }
        else
        {
            StartStandaloneMobileGateway();
            var uiFile = Path.Combine(AppContext.BaseDirectory, "resources", "index.html");
            _dashboard.CoreWebView2.Navigate(new Uri(uiFile).AbsoluteUri);
        }
    }

    private JsonObject LoadState()
    {
        if (File.Exists(_stateFile))
        {
            try
            {
                var parsed = JsonNode.Parse(File.ReadAllText(_stateFile))?.AsObject();
                if (parsed?["watches"] is JsonArray)
                {
                    var dirty = false;
                    if (string.IsNullOrEmpty(parsed["mobileToken"]?.GetValue<string>()))
                    {
                        parsed["mobileToken"] = Guid.NewGuid().ToString("N");
                        dirty = true;
                    }
                    if (!(parsed["tunnelBoxId"]?.GetValue<string>() ?? "").StartsWith("bx_"))
                    {
                        parsed["tunnelBoxId"] = "bx_" + Guid.NewGuid().ToString("N")[..20];
                        dirty = true;
                    }
                    if (string.IsNullOrEmpty(parsed["tunnelWriteKey"]?.GetValue<string>()))
                    {
                        parsed["tunnelWriteKey"] = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N")[..8];
                        dirty = true;
                    }
                    if (dirty) SaveState(parsed);
                    return parsed;
                }
            }
            catch { }
        }
        var watches = new JsonArray();
        if (_isZh)
        {
            watches.Add(new JsonObject { ["id"] = "xianyu-1", ["name"] = "闲鱼买家咨询（1号主店）", ["url"] = "https://www.goofish.com/im", ["category"] = "主力阵地", ["publishTier"] = "red", ["isolatedProfile"] = true, ["status"] = "idle", ["unreadCount"] = 0 });
            watches.Add(new JsonObject { ["id"] = "xhs-1", ["name"] = "小红书创作者消息（1号）", ["url"] = "https://creator.xiaohongshu.com/new/home", ["category"] = "主力阵地", ["publishTier"] = "red", ["isolatedProfile"] = true, ["status"] = "idle", ["unreadCount"] = 0 });
        }
        else
        {
            watches.Add(new JsonObject { ["id"] = "reddit-1", ["name"] = "Reddit Inbox (#1)", ["url"] = "https://www.reddit.com/message/unread/", ["category"] = "接单外包", ["publishTier"] = "red", ["isolatedProfile"] = true, ["status"] = "idle", ["unreadCount"] = 0 });
            watches.Add(new JsonObject { ["id"] = "github-1", ["name"] = "GitHub Notifications", ["url"] = "https://github.com/notifications", ["category"] = "开发者商店", ["publishTier"] = "green", ["isolatedProfile"] = true, ["status"] = "idle", ["unreadCount"] = 0 });
        }
        var init = new JsonObject
        {
            ["version"] = "5.5.0",
            ["mobileToken"] = Guid.NewGuid().ToString("N"),
            ["tunnelBoxId"] = "bx_" + Guid.NewGuid().ToString("N")[..20],
            ["tunnelWriteKey"] = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N")[..8],
            ["settings"] = new JsonObject { ["webhookUrl"] = "", ["lang"] = _isZh ? "zh" : "en", ["preventSleep"] = false, ["tunnelAutoStart"] = false, ["allowLanDirect"] = false },
            ["watches"] = watches,
            ["quickReplies"] = new JsonArray()
        };
        SaveState(init);
        return init;
    }

    private void SaveState(JsonObject st) => File.WriteAllText(_stateFile, st.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

    private static async Task<(bool ok, string channel, string error)> SendWebhookPushAsync(string rawTarget, string siteName, int count, string snippet, string siteUrl, bool isZh)
    {
        var (targetUrl, kind, token) = PushTargetHelper.Normalize(rawTarget);
        if (string.IsNullOrEmpty(targetUrl))
            return (false, kind, isZh ? "口令或链接格式不正确" : "Invalid push token or URL");

        var title = isZh ? $"🔔【消息总管】{siteName} 有 {count} 条新消息" : $"🔔 [ReplyRadar] {count} new unread in {siteName}";
        var bodyText = string.IsNullOrEmpty(snippet) ? siteUrl : (string.IsNullOrEmpty(siteUrl) ? snippet : $"{snippet}\n{siteUrl}");
        var full = $"{title}\n{bodyText}";

        try
        {
            static (bool ok, string channel, string error) EvalJson(HttpResponseMessage resp, string bodyStr, string ch)
            {
                if (!resp.IsSuccessStatusCode) return (false, ch, $"HTTP {(int)resp.StatusCode}");
                try
                {
                    var node = JsonNode.Parse(bodyStr)?.AsObject();
                    if (node != null)
                    {
                        if ((ch == "PushPlus" || ch == "Bark") && node["code"] != null && node["code"]!.GetValue<int>() != 200)
                            return (false, ch, node["msg"]?.GetValue<string>() ?? node["message"]?.GetValue<string>() ?? $"{ch} error");
                        if ((ch == "Server酱" || ch == "飞书") && node["code"] != null && node["code"]!.GetValue<int>() != 0)
                            return (false, ch, node["message"]?.GetValue<string>() ?? node["msg"]?.GetValue<string>() ?? $"{ch} error");
                        if (node["errcode"] != null && node["errcode"]!.GetValue<int>() != 0)
                            return (false, ch, node["errmsg"]?.GetValue<string>() ?? $"{ch} error");
                    }
                }
                catch { }
                return (true, ch, "");
            }

            if (kind == "bark" && targetUrl.Split('/').Length <= 4)
            {
                var r = await Http.GetAsync($"{targetUrl}/{Uri.EscapeDataString(title)}/{Uri.EscapeDataString(bodyText)}?sound=minuet");
                var b = await r.Content.ReadAsStringAsync();
                return EvalJson(r, b, "Bark");
            }
            if (kind == "pushplus_url" && targetUrl.Contains("token="))
            {
                var sep = targetUrl.Contains('?') ? "&" : "?";
                var r = await Http.GetAsync($"{targetUrl}{sep}title={Uri.EscapeDataString(title)}&content={Uri.EscapeDataString(bodyText)}");
                var b = await r.Content.ReadAsStringAsync();
                return EvalJson(r, b, "PushPlus");
            }

            var chLabel = kind switch
            {
                "pushplus" => "PushPlus",
                "serverchan" => "Server酱",
                "feishu" => "飞书",
                "wecom" => "企业微信",
                "dingtalk" => "钉钉",
                "discord" => "Discord",
                _ => "Webhook"
            };

            JsonObject payload = kind switch
            {
                "pushplus" => new JsonObject { ["token"] = token, ["title"] = title, ["content"] = bodyText, ["template"] = "txt" },
                "serverchan" => new JsonObject { ["title"] = title, ["desp"] = bodyText },
                "feishu" => new JsonObject { ["msg_type"] = "text", ["content"] = new JsonObject { ["text"] = full } },
                "wecom" or "dingtalk" => new JsonObject { ["msgtype"] = "text", ["text"] = new JsonObject { ["content"] = full } },
                "discord" => new JsonObject { ["content"] = full },
                _ => new JsonObject { ["text"] = full, ["title"] = title, ["unreadCount"] = count }
            };

            using var content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
            var resp = await Http.PostAsync(targetUrl, content);
            var respText = await resp.Content.ReadAsStringAsync();
            return EvalJson(resp, respText, chLabel);
        }
        catch (Exception ex)
        {
            return (false, kind, ex.Message);
        }
    }

    private async Task HandleJsMessageAsync(string raw)
    {
        var msg = JsonNode.Parse(raw)?.AsObject();
        if (msg == null) return;
        var action = msg["action"]?.GetValue<string>() ?? "";

        if (action == "openLoginSheet")
        {
            var url = msg["url"]?.GetValue<string>() ?? "";
            var name = msg["name"]?.GetValue<string>() ?? "Account";
            var id = msg["id"]?.GetValue<string>() ?? "default";
            await OpenIsolatedWorkspaceAsync(id, name, url);
            return;
        }
        if (action == "openPlaybook")
        {
            var pb = Path.Combine(AppContext.BaseDirectory, "resources", "cold-reply-playbook.html");
            await OpenIsolatedWorkspaceAsync("playbook", _isZh ? "高成交回复话术库" : "Cold-Reply Playbook", new Uri(pb).AbsoluteUri);
            return;
        }
        if (action == "api")
        {
            var reqId = msg["reqId"]?.GetValue<string>() ?? "";
            var method = msg["method"]?.GetValue<string>() ?? "GET";
            var path = msg["path"]?.GetValue<string>() ?? "";
            var body = msg["body"]?.AsObject();
            var resp = await HandleApiAsync(method, path, body);
            var js = $"window.__resolveNativeCallback('{reqId}', {resp.ToJsonString()});";
            await _dashboard.CoreWebView2.ExecuteScriptAsync(js);
        }
    }

    private async Task OpenIsolatedWorkspaceAsync(string watchId, string name, string url)
    {
        if (_workspaceForms.TryGetValue(watchId, out var existing) && !existing.IsDisposed)
        {
            existing.Show();
            existing.WindowState = FormWindowState.Normal;
            existing.Activate();
            return;
        }

        var safeFolder = string.Concat(watchId.Select(c => char.IsLetterOrDigit(c) || c == '-' ? c : '_'));
        var profileDir = Path.Combine(_appRoot, "profiles", safeFolder);
        Directory.CreateDirectory(profileDir);

        var form = new Form
        {
            Text = _isZh ? $"独立防串号工作台 — {name}（支持发图片附件 · 关窗后后台照常静默收听）" : $"Isolated Account Workspace — {name}",
            Width = 1140,
            Height = 800,
            StartPosition = FormStartPosition.CenterParent
        };
        var wv = new WebView2 { Dock = DockStyle.Fill };
        var bar = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 40,
            Padding = new Padding(6, 5, 6, 4),
            BackColor = System.Drawing.Color.FromArgb(241, 245, 249)
        };
        var btnBack = new Button { Text = "←", Width = 38, Height = 28 };
        var btnFwd = new Button { Text = "→", Width = 38, Height = 28 };
        var btnReload = new Button { Text = "↻", Width = 38, Height = 28 };
        var btnHome = new Button { Text = _isZh ? "🏠 消息页" : "🏠 Inbox", Width = 90, Height = 28 };
        var btnPaste = new Button { Text = _isZh ? "⚡ 填入剪贴板话术" : "⚡ Auto-Fill Clipboard", Width = 136, Height = 28 };
        var btnClear = new Button { Text = _isZh ? "✓ 标为已处理" : "✓ Mark Handled", Width = 104, Height = 28 };
        var btnDash = new Button { Text = _isZh ? "📊 回总控台" : "📊 Dashboard", Width = 104, Height = 28 };
        btnBack.Click += (_, _) => { if (wv.CoreWebView2?.CanGoBack == true) wv.CoreWebView2.GoBack(); };
        btnFwd.Click += (_, _) => { if (wv.CoreWebView2?.CanGoForward == true) wv.CoreWebView2.GoForward(); };
        btnReload.Click += (_, _) => wv.CoreWebView2?.Reload();
        btnHome.Click += (_, _) => wv.CoreWebView2?.Navigate(url);
        btnPaste.Click += async (_, _) =>
        {
            var clip = Clipboard.GetText() ?? "";
            if (string.IsNullOrWhiteSpace(clip) || wv.CoreWebView2 == null) return;
            var jsonStr = JsonSerializer.Serialize(clip);
            var js = $@"(function(){{
                const msg = {jsonStr};
                let el = document.activeElement;
                const isEditable = (n) => n && (n.tagName === 'TEXTAREA' || n.isContentEditable || n.getAttribute?.('role') === 'textbox' || (n.tagName === 'INPUT' && !['checkbox','radio','file','submit','button'].includes(n.type)));
                if (!isEditable(el)) {{
                    const cands = Array.from(document.querySelectorAll('textarea, [contenteditable=""true""], [role=""textbox""], input[type=""text""]')).filter(n => n.offsetParent !== null);
                    el = cands[cands.length - 1] || null;
                }}
                if (!el) return false;
                el.focus();
                if (el.isContentEditable || el.getAttribute?.('role') === 'textbox') {{
                    if (!document.execCommand('insertText', false, msg)) {{
                        el.textContent = (el.textContent || '') + msg;
                        el.dispatchEvent(new InputEvent('input', {{ bubbles: true, data: msg, inputType: 'insertText' }}));
                    }}
                    return true;
                }}
                const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                const nextVal = (el.value || '') + msg;
                if (setter) setter.call(el, nextVal); else el.value = nextVal;
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return true;
            }})();";
            await wv.CoreWebView2.ExecuteScriptAsync(js);
        };
        btnClear.Click += async (_, _) =>
        {
            UpdateWatchUnread(watchId, 0, "", false);
            await _dashboard.CoreWebView2.ExecuteScriptAsync("if(window.refreshState) window.refreshState();");
        };
        btnDash.Click += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        bar.Controls.AddRange(new Control[] { btnBack, btnFwd, btnReload, btnHome, btnPaste, btnClear, btnDash });

        form.Controls.Add(wv);
        form.Controls.Add(bar);
        form.FormClosing += (_, e) =>
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                form.Hide();
            }
        };
        _workspaceForms[watchId] = form;
        _workspaceWebViews[watchId] = wv;
        form.Show();

        var env = await CoreWebView2Environment.CreateAsync(null, profileDir);
        await wv.EnsureCoreWebView2Async(env);
        wv.CoreWebView2.NewWindowRequested += (_, args) =>
        {
            if (!string.IsNullOrEmpty(args.Uri))
            {
                args.Handled = true;
                wv.CoreWebView2.Navigate(args.Uri);
            }
        };
        var obsPath = Path.Combine(AppContext.BaseDirectory, "resources", "passive-observer.js");
        if (File.Exists(obsPath))
        {
            await wv.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(obsPath));
        }
        wv.CoreWebView2.WebMessageReceived += async (_, args) =>
        {
            try
            {
                var p = JsonNode.Parse(args.TryGetWebMessageAsString())?.AsObject();
                if (p?["passiveEvent"]?.GetValue<bool>() == true || p?["action"]?.GetValue<string>() == "passiveUnread")
                {
                    var cnt = p["unreadCount"]?.GetValue<int>() ?? 0;
                    var snip = p["snippet"]?.GetValue<string>() ?? "";
                    var authExp = p["authExpired"]?.GetValue<bool>() ?? false;
                    UpdateWatchUnread(watchId, cnt, snip, authExp);
                    await _dashboard.CoreWebView2.ExecuteScriptAsync("if(window.refreshState) window.refreshState();");
                }
            }
            catch { }
        };
        wv.CoreWebView2.DocumentTitleChanged += async (_, _) =>
        {
            var title = wv.CoreWebView2.DocumentTitle ?? "";
            var m = Regex.Match(title, @"(?:\(|\[|【)\s*(\d{1,4})\s*(?:\)|\]|条)");
            var count = m.Success && int.TryParse(m.Groups[1].Value, out var n) ? n : 0;
            if (count > 0)
            {
                UpdateWatchUnread(watchId, count, title, false);
                await _dashboard.CoreWebView2.ExecuteScriptAsync("if(window.refreshState) window.refreshState();");
            }
        };
        wv.CoreWebView2.Navigate(url);
    }

    private void UpdateWatchUnread(string watchId, int count, string snippet, bool authExpired)
    {
        var st = LoadState();
        var watches = st["watches"]?.AsArray();
        if (watches == null) return;
        foreach (var node in watches)
        {
            var obj = node?.AsObject();
            if (obj?["id"]?.GetValue<string>() == watchId)
            {
                var prev = obj["unreadCount"]?.GetValue<int>() ?? 0;
                obj["unreadCount"] = authExpired ? 0 : count;
                obj["status"] = authExpired ? "auth_expired" : (count > 0 ? "unread" : "idle");
                obj["snippet"] = count > 0 ? snippet : "";
                if (!string.IsNullOrEmpty(snippet)) obj["lastSnippet"] = snippet;
                obj["lastCheckedAt"] = DateTime.UtcNow.ToString("O");
                if (!authExpired && count > 0 && count > prev)
                {
                    var siteName = obj["name"]?.GetValue<string>() ?? watchId;
                    var siteUrl = obj["url"]?.GetValue<string>() ?? "";
                    _tray.ShowBalloonTip(4000, _isZh ? "消息总管新消息提醒" : "ReplyRadar Unread Alert", $"{siteName}: {count}", ToolTipIcon.Info);
                    var wh = st["settings"]?["webhookUrl"]?.GetValue<string>() ?? "";
                    if (!string.IsNullOrWhiteSpace(wh))
                        _ = SendWebhookPushAsync(wh, siteName, count, snippet, siteUrl, _isZh);
                }
                break;
            }
        }
        SaveState(st);
    }

    private static JsonObject ScanWindowsDesktopState()
    {
        var badges = new JsonArray();
        var seenBadgeNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var windows = new JsonArray();
        var commProcs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["WeChat"] = "微信",
            ["Weixin"] = "微信",
            ["QQ"] = "QQ",
            ["TIM"] = "TIM",
            ["DingTalk"] = "钉钉",
            ["Feishu"] = "飞书",
            ["Lark"] = "Lark",
            ["WeCom"] = "企业微信",
            ["WXWork"] = "企业微信",
            ["Telegram"] = "Telegram",
            ["Slack"] = "Slack",
            ["Discord"] = "Discord",
            ["WhatsApp"] = "WhatsApp",
            ["AliWorkbench"] = "千牛工作台"
        };
        var browserProcs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "chrome", "msedge", "firefox", "brave" };
        var inboxTitleRe = new Regex(@"(消息中心|私信|聊天|客服|收件箱|未读|猎聘|直聘|BOSS|汇博|智联|前程无忧|拉勾|电鸭|闲鱼|千牛|抖店|创作中心|Inbox|Messages|Notifications|Direct)", RegexOptions.IgnoreCase);

        try
        {
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    var pName = p.ProcessName ?? "";
                    var title = (p.MainWindowTitle ?? "").Trim();
                    if (string.IsNullOrEmpty(title)) continue;

                    if (commProcs.TryGetValue(pName, out var appLabel))
                    {
                        var unreadMatch = Regex.Match(title, @"(?:\(|\[|【)\s*(\d{1,3})\s*(?:\)|\]|条)");
                        var badge = unreadMatch.Success ? unreadMatch.Groups[1].Value : "";
                        var cnt = int.TryParse(badge, out var n) ? n : 0;
                        if (!string.IsNullOrEmpty(badge) && seenBadgeNames.Add(appLabel))
                            badges.Add(new JsonObject { ["name"] = appLabel, ["badge"] = badge });
                        windows.Add(new JsonObject
                        {
                            ["windowId"] = p.Id,
                            ["appName"] = appLabel,
                            ["title"] = title,
                            ["badge"] = badge,
                            ["unreadCount"] = cnt
                        });
                    }
                    else if (browserProcs.Contains(pName) && !title.Contains("消息总管") && !title.Contains("ReplyRadar"))
                    {
                        var unreadMatch = Regex.Match(title, @"(?:\(|\[|【)\s*(\d{1,3})\s*(?:\)|\]|条)");
                        if (inboxTitleRe.IsMatch(title) || unreadMatch.Success)
                        {
                            var clean = Regex.Replace(title, @"\s*-\s*(Google Chrome|Microsoft​?\s*Edge|Mozilla Firefox|Brave).*$", "", RegexOptions.IgnoreCase).Trim();
                            var shortLabel = $"浏览器 · {(clean.Length > 20 ? clean[..20] : clean)}";
                            var badge = unreadMatch.Success ? unreadMatch.Groups[1].Value : "";
                            var cnt = int.TryParse(badge, out var n) ? n : 0;
                            if (!string.IsNullOrEmpty(badge) && seenBadgeNames.Add(shortLabel))
                                badges.Add(new JsonObject { ["name"] = shortLabel, ["badge"] = badge });
                            windows.Add(new JsonObject
                            {
                                ["windowId"] = p.Id,
                                ["appName"] = shortLabel,
                                ["title"] = title,
                                ["badge"] = badge,
                                ["unreadCount"] = cnt,
                                ["snippet"] = "日常浏览器已登录窗口（免重复扫码自动看护）"
                            });
                        }
                    }
                }
                catch { }
            }
        }
        catch { }

        return new JsonObject { ["ok"] = true, ["badges"] = badges, ["windows"] = windows, ["recentAlerts"] = new JsonArray() };
    }

    private async Task<JsonObject> HandleApiAsync(string method, string path, JsonObject? payload)
    {
        var st = LoadState();
        var watches = st["watches"]!.AsArray();

        if (path == "/api/state")
        {
            var unreadWatches = watches.Count(w => w?["status"]?.GetValue<string>() == "unread");
            var unreadTotal = watches.Sum(w => w?["unreadCount"]?.GetValue<int>() ?? 0);
            var licKey = st["license"]?["key"]?.GetValue<string>() ?? "";
            var lic = string.IsNullOrEmpty(licKey) ? new JsonObject { ["valid"] = false, ["plan"] = "free" } : LicenseCheck.Verify(licKey);
            return new JsonObject
            {
                ["version"] = "5.5.0",
                ["license"] = lic,
                ["settings"] = st["settings"]?.DeepClone() ?? new JsonObject(),
                ["stats"] = new JsonObject { ["total"] = watches.Count, ["unreadCount"] = unreadWatches, ["unreadMessagesTotal"] = unreadTotal, ["activeCount"] = watches.Count },
                ["watches"] = watches.DeepClone(),
                ["quickReplies"] = st["quickReplies"]?.DeepClone() ?? new JsonArray()
            };
        }
        if (path == "/api/desktop/state")
        {
            return ScanWindowsDesktopState();
        }
        if (method == "POST" && path == "/api/push/test")
        {
            var raw = payload?["webhookUrl"]?.GetValue<string>() ?? st["settings"]?["webhookUrl"]?.GetValue<string>() ?? "";
            var (ok, channel, err) = await SendWebhookPushAsync(
                raw,
                _isZh ? "测试店铺（独立收件箱）" : "Test Store Inbox",
                1,
                _isZh ? "恭喜！您的手机锁屏强提醒已接通，客户发来新消息时将秒级响铃。" : "Your phone lock-screen alert is live!",
                "",
                _isZh
            );
            return new JsonObject { ["ok"] = ok, ["channel"] = channel, ["error"] = err };
        }
        if (method == "POST" && path == "/api/open-extension-dir")
        {
            var extDir = Path.Combine(AppContext.BaseDirectory, "extension");
            var fallbackDir = Directory.Exists(extDir) ? extDir : Path.Combine(AppContext.BaseDirectory, "resources");
            if (Directory.Exists(fallbackDir))
            {
                Process.Start(new ProcessStartInfo("explorer.exe", $"\"{fallbackDir}\"") { UseShellExecute = true });
                return new JsonObject { ["ok"] = true, ["dir"] = fallbackDir };
            }
            return new JsonObject { ["ok"] = false, ["error"] = "extension folder not found" };
        }
        if (path == "/api/mobile/info")
        {
            return GetStandaloneMobilePairingInfo();
        }
        if (method == "POST" && path == "/api/mobile/tunnel")
        {
            var act = payload?["action"]?.GetValue<string>() ?? "start";
            var allowLan = payload?["allowLanDirect"]?.GetValue<bool>();
            return await HandleStandaloneTunnelActionAsync(act, allowLan);
        }
        if (path == "/api/cc/state" || path == "/api/ai-clients/status" || path == "/api/ai-butler/state")
        {
            return new JsonObject
            {
                ["ok"] = true,
                ["agents"] = new JsonArray(),
                ["sessions"] = new JsonArray(),
                ["hookEvents"] = new JsonArray(),
                ["clients"] = new JsonArray(),
                ["providers"] = new JsonArray { new JsonObject { ["id"] = "rule_fast", ["name"] = "本地零延迟规则过滤", ["installed"] = true } },
                ["suggestions"] = new JsonObject(),
                ["standaloneHint"] = _isZh ? "安装 Node.js 后重开《消息总管》即可解锁本机 Claude Code / Cursor / Codex 自动接入。" : "Install Node.js to unlock local AI CLI & MCP integration."
            };
        }
        if (method == "POST" && path == "/api/quick-replies")
        {
            var qrs = payload?["quickReplies"]?.AsArray()?.DeepClone() ?? new JsonArray();
            st["quickReplies"] = qrs;
            SaveState(st);
            return new JsonObject { ["ok"] = true, ["quickReplies"] = qrs.DeepClone() };
        }
        if (path == "/api/presets")
        {
            var pFile = Path.Combine(AppContext.BaseDirectory, "resources", "presets.json");
            var arr = File.Exists(pFile) ? JsonNode.Parse(File.ReadAllText(pFile)) : new JsonArray();
            return new JsonObject { ["ok"] = true, ["packs"] = arr };
        }
        if (path.StartsWith("/api/scan-leads"))
        {
            var q = "Shopify";
            var idx = path.IndexOf("q=", StringComparison.Ordinal);
            if (idx >= 0) q = Uri.UnescapeDataString(path[(idx + 2)..].Split('&')[0]);
            var leads = new JsonArray();
            try
            {
                if (!Http.DefaultRequestHeaders.UserAgent.Any())
                    Http.DefaultRequestHeaders.UserAgent.ParseAdd("ReplyRadar-Win/5.4");
                var ed = await Http.GetStringAsync("https://svc.eleduck.com/api/v1/posts?page=1");
                var posts = JsonNode.Parse(ed)?["posts"]?.AsArray();
                if (posts != null)
                {
                    var qLower = q.ToLowerInvariant();
                    var hasZh = Regex.IsMatch(q, @"[\u4e00-\u9fa5]");
                    foreach (var p in posts)
                    {
                        var title = p?["full_title"]?.GetValue<string>() ?? p?["title"]?.GetValue<string>() ?? "";
                        var sum = p?["summary"]?.GetValue<string>() ?? "";
                        if (string.IsNullOrWhiteSpace(title) || title.Contains("社区规则")) continue;
                        var hay = $"{title} {sum}".ToLowerInvariant();
                        if (!hay.Contains(qLower) && !(hasZh && (hay.Contains("远程") || hay.Contains("外包") || hay.Contains("招")))) continue;
                        leads.Add(new JsonObject
                        {
                            ["source"] = "电鸭社区 · 远程/外包",
                            ["title"] = title,
                            ["snippet"] = sum.Length > 140 ? sum[..140] : sum,
                            ["url"] = $"https://eleduck.com/posts/{p?["id"]}",
                            ["publishedAt"] = p?["published_at"]?.GetValue<string>() ?? DateTime.UtcNow.ToString("O"),
                            ["intentScore"] = 92
                        });
                        if (leads.Count >= 6) break;
                    }
                }
            }
            catch { }
            try
            {
                if (!Http.DefaultRequestHeaders.UserAgent.Any())
                    Http.DefaultRequestHeaders.UserAgent.ParseAdd("ReplyRadar-Win/5.4");
                var hn = await Http.GetStringAsync($"https://hn.algolia.com/api/v1/search_by_date?query={Uri.EscapeDataString(q + " hiring freelance")}&tags=(story,comment)&hitsPerPage=8");
                var hits = JsonNode.Parse(hn)?["hits"]?.AsArray();
                if (hits != null)
                {
                    foreach (var h in hits)
                    {
                        leads.Add(new JsonObject
                        {
                            ["source"] = "Hacker News",
                            ["title"] = h?["title"]?.GetValue<string>() ?? h?["story_title"]?.GetValue<string>() ?? "Hiring Thread",
                            ["snippet"] = "",
                            ["url"] = $"https://news.ycombinator.com/item?id={h?["objectID"]}",
                            ["publishedAt"] = DateTime.UtcNow.ToString("O"),
                            ["intentScore"] = 88
                        });
                    }
                }
            }
            catch { }
            return new JsonObject { ["ok"] = true, ["leads"] = leads };
        }
        if (path == "/api/license/activate")
        {
            var key = payload?["key"]?.GetValue<string>() ?? "";
            var check = LicenseCheck.Verify(key);
            if (check["valid"]?.GetValue<bool>() == true)
            {
                st["license"] = new JsonObject { ["key"] = key, ["activatedAt"] = DateTime.UtcNow.ToString("O") };
                SaveState(st);
                return new JsonObject { ["ok"] = true, ["license"] = check };
            }
            return new JsonObject { ["ok"] = false, ["error"] = check["error"]?.GetValue<string>() ?? "Invalid" };
        }
        if (path == "/api/settings")
        {
            var set = st["settings"]?.AsObject() ?? new JsonObject();
            if (payload?["webhookUrl"] != null) set["webhookUrl"] = payload["webhookUrl"]!.GetValue<string>();
            if (payload?["termsAcceptedAt"] != null) set["termsAcceptedAt"] = payload["termsAcceptedAt"]!.GetValue<string>();
            if (payload?["aiButlerEnabled"] != null) set["aiButlerEnabled"] = payload["aiButlerEnabled"]!.GetValue<bool>();
            if (payload?["aiButlerProvider"] != null) set["aiButlerProvider"] = payload["aiButlerProvider"]!.GetValue<string>();
            if (payload?["aiButlerPersona"] != null) set["aiButlerPersona"] = payload["aiButlerPersona"]!.GetValue<string>();
            if (payload?["preventSleep"] != null)
            {
                var ps = payload["preventSleep"]!.GetValue<bool>();
                set["preventSleep"] = ps;
                WinPowerKeeper.ApplyPreventSleep(ps);
            }
            if (payload?["allowLanDirect"] != null)
            {
                var al = payload["allowLanDirect"]!.GetValue<bool>();
                set["allowLanDirect"] = al;
                EnsureMobileTcpListener(al);
            }
            st["settings"] = set;
            SaveState(st);
            return new JsonObject { ["ok"] = true, ["settings"] = set.DeepClone() };
        }
        if (method == "POST" && path == "/api/watches")
        {
            var rawUrl = (payload?["url"]?.GetValue<string>() ?? "").Trim();
            if (!string.IsNullOrEmpty(rawUrl) && !rawUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !rawUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                rawUrl = "https://" + rawUrl;
            var explicitId = payload?["id"]?.GetValue<string>();
            var allowDup = payload?["allowDuplicateUrl"]?.GetValue<bool>() ?? false;
            var id = !string.IsNullOrWhiteSpace(explicitId) ? explicitId! : $"acc-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}-{Random.Shared.Next(100, 999)}";
            var item = new JsonObject
            {
                ["id"] = id,
                ["name"] = payload?["name"]?.GetValue<string>() ?? "Account",
                ["url"] = rawUrl,
                ["category"] = payload?["category"]?.GetValue<string>() ?? "主力阵地",
                ["publishTier"] = payload?["publishTier"]?.GetValue<string>() ?? "red",
                ["isolatedProfile"] = true,
                ["contextSummary"] = payload?["contextSummary"]?.GetValue<string>() ?? "",
                ["status"] = "idle",
                ["unreadCount"] = 0
            };
            int existingIdx = -1;
            for (int i = 0; i < watches.Count; i++)
            {
                var w = watches[i]?.AsObject();
                if (w == null) continue;
                if ((!string.IsNullOrWhiteSpace(explicitId) && w["id"]?.GetValue<string>() == explicitId) ||
                    (string.IsNullOrWhiteSpace(explicitId) && !allowDup && w["url"]?.GetValue<string>() == rawUrl))
                {
                    existingIdx = i;
                    break;
                }
            }
            if (existingIdx >= 0) watches[existingIdx] = item;
            else watches.Add(item);
            SaveState(st);
            return new JsonObject { ["ok"] = true, ["watch"] = item.DeepClone() };
        }
        if (method == "DELETE" && path.StartsWith("/api/watches/"))
        {
            var delId = Uri.UnescapeDataString(path["/api/watches/".Length..]);
            if (_workspaceForms.TryGetValue(delId, out var wf))
            {
                _workspaceForms.Remove(delId);
                try { wf.Dispose(); } catch { }
            }
            for (int i = watches.Count - 1; i >= 0; i--)
                if (watches[i]?["id"]?.GetValue<string>() == delId) watches.RemoveAt(i);
            SaveState(st);
            return new JsonObject { ["ok"] = true, ["deleted"] = true };
        }
        if (method == "POST" && path.EndsWith("/resolve"))
        {
            var targetId = Uri.UnescapeDataString(path.Replace("/api/watches/", "").Replace("/resolve", ""));
            var act = payload?["action"]?.GetValue<string>() ?? "resolve";
            foreach (var w in watches)
            {
                var o = w?.AsObject();
                if (o?["id"]?.GetValue<string>() == targetId)
                {
                    o["status"] = act == "pause" ? "paused" : "idle";
                    if (act != "pause") o["unreadCount"] = 0;
                }
            }
            SaveState(st);
            return new JsonObject { ["ok"] = true };
        }
        if (method == "POST" && path.EndsWith("/draft"))
        {
            var targetId = Uri.UnescapeDataString(path.Replace("/api/watches/", "").Replace("/draft", ""));
            var draft = payload?["draft"]?.GetValue<string>() ?? "";
            foreach (var w in watches)
            {
                var o = w?.AsObject();
                if (o?["id"]?.GetValue<string>() == targetId) o["lastDraft"] = draft;
            }
            SaveState(st);
            return new JsonObject { ["ok"] = true };
        }
        return new JsonObject { ["ok"] = true };
    }

    private static string GetLanIPv4()
    {
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                {
                    if (ua.Address.AddressFamily == AddressFamily.InterNetwork)
                    {
                        var ip = ua.Address.ToString();
                        if (ip.StartsWith("192.168.") || ip.StartsWith("10.") || ip.StartsWith("172.")) return ip;
                    }
                }
            }
        }
        catch { }
        return "127.0.0.1";
    }

    private void EnsureMobileTcpListener(bool allowLan)
    {
        if (_mobileListener != null && _boundLanMode == allowLan) return;
        try { _mobileListener?.Stop(); } catch { }
        _mobileListener = null;
        _boundLanMode = allowLan;

        var bindAddr = allowLan ? IPAddress.Any : IPAddress.Loopback;
        foreach (var p in new[] { 17890, 17891, 17892 })
        {
            try
            {
                var l = new TcpListener(bindAddr, p);
                l.Start();
                _mobilePort = p;
                _mobileListener = l;
                _ = Task.Run(async () =>
                {
                    while (true)
                    {
                        try
                        {
                            var client = await l.AcceptTcpClientAsync();
                            _ = Task.Run(() => HandleMobileTcpClientAsync(client));
                        }
                        catch { break; }
                    }
                });
                break;
            }
            catch { }
        }
    }

    private void StartStandaloneMobileGateway()
    {
        var st = LoadState();
        var ps = st["settings"]?["preventSleep"]?.GetValue<bool>() ?? false;
        var allowLan = st["settings"]?["allowLanDirect"]?.GetValue<bool>() ?? false;
        WinPowerKeeper.ApplyPreventSleep(ps);
        EnsureMobileTcpListener(allowLan);

        if (st["settings"]?["tunnelAutoStart"]?.GetValue<bool>() == true)
        {
            _wantedTunnel = true;
            _ = StartSshTunnelAsync();
        }
    }

    private JsonObject GetStandaloneMobilePairingInfo()
    {
        var st = LoadState();
        var tok = st["mobileToken"]?.GetValue<string>() ?? "";
        var boxId = st["tunnelBoxId"]?.GetValue<string>() ?? "";
        var ps = st["settings"]?["preventSleep"]?.GetValue<bool>() ?? false;
        var allowLan = st["settings"]?["allowLanDirect"]?.GetValue<bool>() ?? false;
        var detectedIp = GetLanIPv4();
        var lanUrl = allowLan ? $"http://{detectedIp}:{_mobilePort}/m?t={tok}" : $"http://127.0.0.1:{_mobilePort}/m?t={tok}";
        var permUrl = (!string.IsNullOrEmpty(_publicTunnelUrl) && !string.IsNullOrEmpty(boxId))
            ? $"{EdgeGatewayOrigin}/go/{boxId}?t={tok}"
            : "";
        var rawTun = !string.IsNullOrEmpty(_publicTunnelUrl) ? $"{_publicTunnelUrl}/m?t={tok}" : "";
        var tunUrl = !string.IsNullOrEmpty(permUrl) ? permUrl : rawTun;
        var primary = !string.IsNullOrEmpty(tunUrl) ? tunUrl : lanUrl;
        return new JsonObject
        {
            ["ok"] = true,
            ["status"] = _tunnelStatus,
            ["publicUrl"] = _publicTunnelUrl,
            ["permanentMobileUrl"] = permUrl,
            ["tunnelMobileUrl"] = tunUrl,
            ["lanUrl"] = lanUrl,
            ["allowLanDirect"] = allowLan,
            ["detectedLanIp"] = detectedIp,
            ["primaryUrl"] = primary,
            ["preventSleep"] = ps
        };
    }

    private async Task<JsonObject> HandleStandaloneTunnelActionAsync(string action, bool? allowLanParam = null)
    {
        var st = LoadState();
        var set = st["settings"]?.AsObject() ?? new JsonObject();
        if (action == "rotateToken")
        {
            st["mobileToken"] = Guid.NewGuid().ToString("N");
            SaveState(st);
            return GetStandaloneMobilePairingInfo();
        }
        if (action == "toggleLan")
        {
            var nextLan = allowLanParam ?? !(set["allowLanDirect"]?.GetValue<bool>() ?? false);
            set["allowLanDirect"] = nextLan;
            st["settings"] = set;
            SaveState(st);
            EnsureMobileTcpListener(nextLan);
            return GetStandaloneMobilePairingInfo();
        }
        if (action == "emergencyLock")
        {
            _wantedTunnel = false;
            set["tunnelAutoStart"] = false;
            set["allowLanDirect"] = false;
            st["settings"] = set;
            st["mobileToken"] = Guid.NewGuid().ToString("N");
            SaveState(st);
            try { _sshTunnelProc?.Kill(); } catch { }
            _sshTunnelProc = null;
            _publicTunnelUrl = "";
            _tunnelStatus = "stopped";
            EnsureMobileTcpListener(false);
            return GetStandaloneMobilePairingInfo();
        }
        if (action == "stop")
        {
            _wantedTunnel = false;
            set["tunnelAutoStart"] = false;
            st["settings"] = set;
            SaveState(st);
            try { _sshTunnelProc?.Kill(); } catch { }
            _sshTunnelProc = null;
            _publicTunnelUrl = "";
            _tunnelStatus = "stopped";
            return GetStandaloneMobilePairingInfo();
        }
        _wantedTunnel = true;
        set["tunnelAutoStart"] = true;
        set["preventSleep"] = true;
        st["settings"] = set;
        SaveState(st);
        WinPowerKeeper.ApplyPreventSleep(true);
        await StartSshTunnelAsync();
        return GetStandaloneMobilePairingInfo();
    }

    private async Task SyncEdgeBookmarkWinAsync()
    {
        try
        {
            var st = LoadState();
            var boxId = st["tunnelBoxId"]?.GetValue<string>() ?? "";
            var writeKey = st["tunnelWriteKey"]?.GetValue<string>() ?? "";
            if (string.IsNullOrEmpty(_publicTunnelUrl) || string.IsNullOrEmpty(boxId)) return;
            var payload = new JsonObject
            {
                ["boxId"] = boxId,
                ["writeKey"] = writeKey,
                ["targetOrigin"] = _publicTunnelUrl
            };
            using var content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
            await Http.PostAsync($"{EdgeGatewayOrigin}/api/tunnel/sync", content);
        }
        catch { }
    }

    private async Task StartSshTunnelAsync()
    {
        if (_sshTunnelProc is { HasExited: false } && !string.IsNullOrEmpty(_publicTunnelUrl)) return;
        try { _sshTunnelProc?.Kill(); } catch { }
        _publicTunnelUrl = "";
        _tunnelStatus = "starting";

        var sshExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "OpenSSH", "ssh.exe");
        if (!File.Exists(sshExe)) sshExe = "ssh.exe";

        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = sshExe,
                Arguments = $"-T -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 80:127.0.0.1:{_mobilePort} nokey@localhost.run",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            void OnLine(string? line)
            {
                if (string.IsNullOrEmpty(line)) return;
                var m = Regex.Match(line, @"https://[a-zA-Z0-9.-]+\.lhr\.life");
                if (m.Success && _publicTunnelUrl != m.Value)
                {
                    _publicTunnelUrl = m.Value;
                    _tunnelStatus = "running";
                    _ = SyncEdgeBookmarkWinAsync();
                    tcs.TrySetResult(true);
                }
            }
            proc.OutputDataReceived += (_, e) => OnLine(e.Data);
            proc.ErrorDataReceived += (_, e) => OnLine(e.Data);
            proc.Exited += (_, _) =>
            {
                if (_sshTunnelProc == proc)
                {
                    _sshTunnelProc = null;
                    _publicTunnelUrl = "";
                    _tunnelStatus = "stopped";
                    if (_wantedTunnel)
                    {
                        _ = Task.Run(async () =>
                        {
                            await Task.Delay(6000);
                            if (_wantedTunnel) await StartSshTunnelAsync();
                        });
                    }
                }
                tcs.TrySetResult(false);
            };
            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            _sshTunnelProc = proc;
            await Task.WhenAny(tcs.Task, Task.Delay(6200));
        }
        catch
        {
            _tunnelStatus = "error";
        }
    }

    private async Task HandleMobileTcpClientAsync(TcpClient client)
    {
        using (client)
        {
            client.ReceiveTimeout = 5000;
            client.SendTimeout = 5000;
            using var stream = client.GetStream();
            var buf = new byte[65536];
            var mem = new MemoryStream();
            int headerEnd = -1;
            int contentLen = 0;

            while (true)
            {
                var n = await stream.ReadAsync(buf);
                if (n <= 0) break;
                mem.Write(buf, 0, n);
                var arr = mem.ToArray();
                if (headerEnd < 0)
                {
                    var s = Encoding.UTF8.GetString(arr);
                    var idx = s.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                    if (idx >= 0)
                    {
                        headerEnd = Encoding.UTF8.GetByteCount(s[..(idx + 4)]);
                        foreach (var hl in s[..idx].Split("\r\n"))
                        {
                            if (hl.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                                int.TryParse(hl[15..].Trim(), out contentLen);
                        }
                    }
                }
                if (headerEnd >= 0 && mem.Length - headerEnd >= contentLen) break;
            }
            if (headerEnd < 0) return;

            var allBytes = mem.ToArray();
            var headerText = Encoding.UTF8.GetString(allBytes, 0, headerEnd - 4);
            var bodyText = contentLen > 0 ? Encoding.UTF8.GetString(allBytes, headerEnd, Math.Min(contentLen, allBytes.Length - headerEnd)) : "";
            var lines = headerText.Split("\r\n");
            var reqParts = lines[0].Split(' ');
            if (reqParts.Length < 2) return;
            var method = reqParts[0];
            var uri = new Uri("http://127.0.0.1" + reqParts[1]);
            var pathname = uri.AbsolutePath;

            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var l in lines.Skip(1))
            {
                var c = l.IndexOf(':');
                if (c > 0) headers[l[..c].Trim()] = l[(c + 1)..].Trim();
            }

            async Task SendRawAsync(int code, string ct, byte[] data, string extra = "")
            {
                var head = $"HTTP/1.1 {code} OK\r\nContent-Type: {ct}\r\nContent-Length: {data.Length}\r\nCache-Control: no-store\r\nConnection: close\r\n{extra}\r\n";
                var hb = Encoding.UTF8.GetBytes(head);
                await stream.WriteAsync(hb);
                await stream.WriteAsync(data);
            }

            Task SendJsonObjAsync(JsonObject obj, int code = 200, string extra = "") =>
                SendRawAsync(code, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(obj.ToJsonString()), extra);

            if (pathname == "/api/health")
            {
                await SendJsonObjAsync(new JsonObject { ["ok"] = true, ["version"] = "5.5.0", ["standalone"] = true });
                return;
            }
            if (pathname == "/sw.js")
            {
                var sw = Path.Combine(AppContext.BaseDirectory, "resources", "sw.js");
                if (File.Exists(sw)) await SendRawAsync(200, "application/javascript; charset=utf-8", File.ReadAllBytes(sw), "Service-Worker-Allowed: /\r\n");
                return;
            }

            if (pathname.StartsWith("/api/mobile/") || pathname == "/api/settings" || pathname == "/api/license/activate")
            {
                await SendJsonObjAsync(new JsonObject { ["ok"] = false, ["error"] = "desktop only" }, 403);
                return;
            }

            var clientIp = headers.TryGetValue("X-Forwarded-For", out var xff)
                ? xff.Split(',')[0].Trim()
                : (client.Client.RemoteEndPoint?.ToString() ?? "unknown");
            lock (_failedAuthByIp)
            {
                if (_failedAuthByIp.TryGetValue(clientIp, out var rec) && rec.count >= 8 && (DateTime.UtcNow - rec.lastAt).TotalMinutes < 10)
                {
                    _ = SendJsonObjAsync(new JsonObject { ["ok"] = false, ["error"] = "Too many invalid attempts. Locked for 10m." }, 429);
                    return;
                }
            }

            var st = LoadState();
            var expectedTok = st["mobileToken"]?.GetValue<string>() ?? "";
            var queryTok = "";
            foreach (var qp in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var kv = qp.Split('=', 2);
                if (kv.Length == 2 && kv[0] == "t") queryTok = Uri.UnescapeDataString(kv[1]);
            }
            var cookieTok = "";
            if (headers.TryGetValue("Cookie", out var ck))
            {
                foreach (var seg in ck.Split(';'))
                {
                    var kv = seg.Trim().Split('=', 2);
                    if (kv.Length == 2 && kv[0] == "tp_mob_tok") cookieTok = Uri.UnescapeDataString(kv[1]);
                }
            }
            headers.TryGetValue("X-TabPulse-Token", out var hdrTok);
            var candidateTok = !string.IsNullOrEmpty(queryTok) ? queryTok : (!string.IsNullOrEmpty(hdrTok) ? hdrTok : cookieTok);
            if (!string.IsNullOrEmpty(expectedTok) && candidateTok != expectedTok)
            {
                if (!string.IsNullOrEmpty(candidateTok))
                {
                    lock (_failedAuthByIp)
                    {
                        var prev = _failedAuthByIp.TryGetValue(clientIp, out var r) ? r.count : 0;
                        _failedAuthByIp[clientIp] = (prev + 1, DateTime.UtcNow);
                    }
                }
                await SendRawAsync(401, "text/html; charset=utf-8", Encoding.UTF8.GetBytes("<!doctype html><meta charset='utf-8'/><meta name='referrer' content='no-referrer'/><body style='background:#0f172a;color:#fff;display:grid;place-items:center;min-height:100vh'><h2>🔒 请用手机扫描电脑端《消息总管》二维码进入</h2></body>"));
                return;
            }
            lock (_failedAuthByIp) { _failedAuthByIp.Remove(clientIp); }
            var extraCookie = "Referrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n" + (!string.IsNullOrEmpty(queryTok) ? $"Set-Cookie: tp_mob_tok={expectedTok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000\r\n" : "");

            if (pathname == "/" || pathname == "/m")
            {
                var mf = Path.Combine(AppContext.BaseDirectory, "resources", "mobile.html");
                if (File.Exists(mf)) await SendRawAsync(200, "text/html; charset=utf-8", File.ReadAllBytes(mf), extraCookie);
                return;
            }
            if (pathname == "/api/events-stream")
            {
                await SendRawAsync(200, "text/event-stream; charset=utf-8", Encoding.UTF8.GetBytes("data: {\"kind\":\"connected\"}\n\n"), extraCookie);
                return;
            }
            if (pathname == "/api/cc/state" || pathname == "/api/ai-inbox/state" || pathname == "/api/ai-butler/state")
            {
                await SendJsonObjAsync(new JsonObject { ["ok"] = true, ["sessions"] = new JsonArray(), ["hookEvents"] = new JsonArray(), ["channels"] = new JsonArray(), ["suggestions"] = new JsonObject() }, 200, extraCookie);
                return;
            }
            var bodyObj = !string.IsNullOrWhiteSpace(bodyText) ? JsonNode.Parse(bodyText)?.AsObject() : null;
            var apiOut = await HandleApiAsync(method, pathname, bodyObj);
            await SendJsonObjAsync(apiOut, 200, extraCookie);
        }
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Contains("--self-test"))
        {
            var bad = LicenseCheck.Verify("TP1.fake.fake");
            if (bad["valid"]?.GetValue<bool>() != false) return 2;
            var pp = PushTargetHelper.Normalize("a1b2c3d4e5f60718293a4b5c6d7e8f90");
            if (pp.kind != "pushplus") return 3;
            var sc = PushTargetHelper.Normalize("SCT123456abcdef7890");
            if (sc.kind != "serverchan") return 4;
            var bk = PushTargetHelper.Normalize("AbCdEfGhIjKlMnOpQrStUv");
            if (bk.kind != "bark") return 5;
            Console.WriteLine("WIN_SELFTEST_OK");
            return 0;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MainDashboardForm());
        return 0;
    }
}

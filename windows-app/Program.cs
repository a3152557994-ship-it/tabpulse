using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace TabPulseWin;

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

internal sealed class MainDashboardForm : Form
{
    private readonly WebView2 _dashboard = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon _tray;
    private readonly bool _isZh = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.Equals("zh", StringComparison.OrdinalIgnoreCase);
    private readonly string _appRoot;
    private readonly string _stateFile;
    private readonly Dictionary<string, Form> _workspaceForms = new();
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(6) };

    public MainDashboardForm()
    {
        _appRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TabPulse");
        Directory.CreateDirectory(Path.Combine(_appRoot, "profiles"));
        _stateFile = Path.Combine(_appRoot, "state.json");

        Text = _isZh ? "消息总管 — 多平台未读消息提醒与多开防串号盒子 (v2.0.0)" : "ReplyRadar — Multi-Account Unread Inbox & Lead Radar (v2.0.0)";
        Width = 1200;
        Height = 800;
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_dashboard);

        var menu = new ContextMenuStrip();
        menu.Items.Add(_isZh ? "打开消息总管主窗口" : "Open ReplyRadar", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add(_isZh ? "彻底退出" : "Quit", null, (_, _) => { _tray!.Visible = false; Environment.Exit(0); });

        _tray = new NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Information,
            Text = _isZh ? "消息总管 · 运行中" : "ReplyRadar · Active",
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

    private async Task InitWebViewAsync()
    {
        var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_appRoot, "dashboard-webview"));
        await _dashboard.EnsureCoreWebView2Async(env);
        await _dashboard.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.__TABPULSE_STANDALONE_MODE = true;");
        _dashboard.CoreWebView2.WebMessageReceived += async (_, args) => await HandleJsMessageAsync(args.TryGetWebMessageAsString());
        _dashboard.CoreWebView2.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            if (!string.IsNullOrEmpty(args.Uri))
                Process.Start(new ProcessStartInfo(args.Uri) { UseShellExecute = true });
        };

        var uiFile = Path.Combine(AppContext.BaseDirectory, "resources", "index.html");
        _dashboard.CoreWebView2.Navigate(new Uri(uiFile).AbsoluteUri);
    }

    private JsonObject LoadState()
    {
        if (File.Exists(_stateFile))
        {
            try
            {
                var parsed = JsonNode.Parse(File.ReadAllText(_stateFile))?.AsObject();
                if (parsed?["watches"] is JsonArray) return parsed;
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
            ["version"] = "2.0.0",
            ["settings"] = new JsonObject { ["webhookUrl"] = "", ["lang"] = _isZh ? "zh" : "en" },
            ["watches"] = watches,
            ["quickReplies"] = new JsonArray()
        };
        SaveState(init);
        return init;
    }

    private void SaveState(JsonObject st) => File.WriteAllText(_stateFile, st.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

    private static void SendWebhookPush(string webhookUrl, string siteName, int count, string snippet, string siteUrl, bool isZh)
    {
        var trimmed = (webhookUrl ?? "").Trim();
        if (string.IsNullOrEmpty(trimmed) || !Uri.TryCreate(trimmed, UriKind.Absolute, out _)) return;
        var title = isZh ? $"🔔【消息总管】{siteName} 有 {count} 条新消息" : $"🔔 [ReplyRadar] {count} new unread in {siteName}";
        var bodyText = string.IsNullOrEmpty(snippet) ? siteUrl : $"{snippet}\n{siteUrl}";
        var full = $"{title}\n{bodyText}";

        _ = Task.Run(async () =>
        {
            try
            {
                if (trimmed.Contains("api.day.app/") && trimmed.Split('/').Length == 4)
                {
                    await Http.GetAsync($"{trimmed}/{Uri.EscapeDataString(title)}/{Uri.EscapeDataString(bodyText)}");
                    return;
                }
                JsonObject payload;
                if (trimmed.Contains("feishu.cn") || trimmed.Contains("larksuite.com"))
                    payload = new JsonObject { ["msg_type"] = "text", ["content"] = new JsonObject { ["text"] = full } };
                else if (trimmed.Contains("qyapi.weixin.qq.com"))
                    payload = new JsonObject { ["msgtype"] = "text", ["text"] = new JsonObject { ["content"] = full } };
                else if (trimmed.Contains("discord.com/api/webhooks"))
                    payload = new JsonObject { ["content"] = full };
                else if (trimmed.Contains("sctapi.ftqq.com"))
                    payload = new JsonObject { ["title"] = title, ["desp"] = bodyText };
                else
                    payload = new JsonObject { ["text"] = full, ["title"] = title, ["unreadCount"] = count };

                using var content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
                await Http.PostAsync(trimmed, content);
            }
            catch { }
        });
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

        // Physical per-account WebView2 folder isolation (100% separate cookies per Xianyu/Xiaohongshu/Reddit account!)
        var safeFolder = string.Concat(watchId.Select(c => char.IsLetterOrDigit(c) || c == '-' ? c : '_'));
        var profileDir = Path.Combine(_appRoot, "profiles", safeFolder);
        Directory.CreateDirectory(profileDir);

        var form = new Form
        {
            Text = _isZh ? $"独立防串号工作台 — {name}（关掉窗口后后台照常收听新消息）" : $"Isolated Account Workspace — {name}",
            Width = 1120,
            Height = 780,
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
        var btnDash = new Button { Text = _isZh ? "📊 回总控台" : "📊 Dashboard", Width = 104, Height = 28 };
        btnBack.Click += (_, _) => { if (wv.CoreWebView2?.CanGoBack == true) wv.CoreWebView2.GoBack(); };
        btnFwd.Click += (_, _) => { if (wv.CoreWebView2?.CanGoForward == true) wv.CoreWebView2.GoForward(); };
        btnReload.Click += (_, _) => wv.CoreWebView2?.Reload();
        btnHome.Click += (_, _) => wv.CoreWebView2?.Navigate(url);
        btnDash.Click += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        bar.Controls.AddRange(new Control[] { btnBack, btnFwd, btnReload, btnHome, btnDash });

        form.Controls.Add(wv);
        form.Controls.Add(bar);
        form.FormClosing += (_, e) =>
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                form.Hide(); // Keep live WebSocket open passively in background with 0 page reloads!
            }
        };
        _workspaceForms[watchId] = form;
        form.Show();

        var env = await CoreWebView2Environment.CreateAsync(null, profileDir);
        await wv.EnsureCoreWebView2Async(env);
        var obsPath = Path.Combine(AppContext.BaseDirectory, "resources", "passive-observer.js");
        if (File.Exists(obsPath))
        {
            await wv.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(obsPath));
        }
        wv.CoreWebView2.WebMessageReceived += (_, args) =>
        {
            try
            {
                var p = JsonNode.Parse(args.TryGetWebMessageAsString())?.AsObject();
                if (p?["action"]?.GetValue<string>() == "passiveUnread")
                {
                    var cnt = p["unreadCount"]?.GetValue<int>() ?? 0;
                    var snip = p["snippet"]?.GetValue<string>() ?? "";
                    UpdateWatchUnread(watchId, cnt, snip);
                }
            }
            catch { }
        };
        wv.CoreWebView2.DocumentTitleChanged += (_, _) =>
        {
            var title = wv.CoreWebView2.DocumentTitle ?? "";
            var m = System.Text.RegularExpressions.Regex.Match(title, @"(?:\(|\[|【)\s*(\d{1,4})\s*(?:\)|\]|条)");
            var count = m.Success && int.TryParse(m.Groups[1].Value, out var n) ? n : 0;
            if (count > 0) UpdateWatchUnread(watchId, count, title);
        };
        wv.CoreWebView2.Navigate(url);
    }

    private void UpdateWatchUnread(string watchId, int count, string snippet)
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
                obj["unreadCount"] = count;
                obj["status"] = count > 0 ? "unread" : "idle";
                obj["snippet"] = snippet;
                if (count > 0 && count > prev)
                {
                    var siteName = obj["name"]?.GetValue<string>() ?? watchId;
                    var siteUrl = obj["url"]?.GetValue<string>() ?? "";
                    _tray.ShowBalloonTip(4000, _isZh ? "消息总管新消息提醒" : "ReplyRadar Unread Alert", $"{siteName}: {count}", ToolTipIcon.Info);
                    var wh = st["settings"]?["webhookUrl"]?.GetValue<string>() ?? "";
                    SendWebhookPush(wh, siteName, count, snippet, siteUrl, _isZh);
                }
                break;
            }
        }
        SaveState(st);
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
                ["version"] = "2.0.0",
                ["license"] = lic,
                ["settings"] = st["settings"]?.DeepClone() ?? new JsonObject(),
                ["stats"] = new JsonObject { ["total"] = watches.Count, ["unreadCount"] = unreadWatches, ["unreadMessagesTotal"] = unreadTotal, ["activeCount"] = watches.Count },
                ["watches"] = watches.DeepClone(),
                ["quickReplies"] = st["quickReplies"]?.DeepClone() ?? new JsonArray()
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
                Http.DefaultRequestHeaders.UserAgent.ParseAdd("ReplyRadar-Win/2.0");
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
            st["settings"] = set;
            SaveState(st);
            return new JsonObject { ["ok"] = true, ["settings"] = set.DeepClone() };
        }
        if (method == "POST" && path == "/api/watches")
        {
            var id = payload?["id"]?.GetValue<string>() ?? $"acc-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}-{Random.Shared.Next(100, 999)}";
            var item = new JsonObject
            {
                ["id"] = id,
                ["name"] = payload?["name"]?.GetValue<string>() ?? "Account",
                ["url"] = payload?["url"]?.GetValue<string>() ?? "",
                ["category"] = payload?["category"]?.GetValue<string>() ?? "主力阵地",
                ["publishTier"] = payload?["publishTier"]?.GetValue<string>() ?? "red",
                ["isolatedProfile"] = true,
                ["contextSummary"] = payload?["contextSummary"]?.GetValue<string>() ?? "",
                ["status"] = "idle",
                ["unreadCount"] = 0
            };
            watches.Add(item);
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
            Console.WriteLine("WIN_SELFTEST_OK");
            return 0;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MainDashboardForm());
        return 0;
    }
}

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;
using System.Runtime.InteropServices;

namespace OpenCodeTailnetLauncher
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            var exe = Process.GetCurrentProcess().MainModule.FileName;
            var args = Environment.GetCommandLineArgs();
            if (args.Length > 1)
            {
                try
                {
                    var cmd = args[1].Trim().ToLowerInvariant();
                    if (cmd == "--install-autostart")
                    {
                        TrayApp.SetAutostart(true, exe);
                        return;
                    }
                    if (cmd == "--remove-autostart")
                    {
                        TrayApp.SetAutostart(false, exe);
                        return;
                    }
                }
                catch (Exception ex)
                {
                    var dir = Path.GetDirectoryName(exe);
                    File.AppendAllText(Path.Combine(dir, "launcher-cli-error.log"), ex.ToString() + Environment.NewLine);
                    return;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp());
        }
    }

    internal sealed class TrayApp : ApplicationContext
    {
        private const string AppName = "OpenCode Tailnet Launcher";
        private const string AppVersion = "v0.1.1";
        private readonly NotifyIcon tray;
        private readonly Timer timer;
        private readonly ToolStripMenuItem stateItem;
        private readonly ToolStripMenuItem autostartItem;
        private readonly Icon iconBase;
        private readonly Icon iconRunning;
        private readonly Icon iconStarting;
        private readonly Icon iconWaiting;
        private readonly Icon iconError;
        private readonly Settings cfg;
        private readonly string exePath;
        private readonly string root;
        private readonly string logDir;
        private readonly string logFile;
        private readonly string iconPath;
        private Process child;
        private bool busy;
        private bool exiting;
        private string host;
        private string version;
        private DateTime lastStart = DateTime.MinValue;

        public TrayApp()
        {
            this.exePath = Application.ExecutablePath;
            this.root = Path.GetDirectoryName(this.exePath);
            this.logDir = Path.Combine(this.root, "logs");
            this.logFile = Path.Combine(this.logDir, "launcher.log");
            this.iconPath = Path.Combine(this.root, "OpenCodeTailnetLauncher.ico");
            Directory.CreateDirectory(this.logDir);
            this.cfg = Settings.Load(this.root);

            this.stateItem = new ToolStripMenuItem("State: starting");
            this.stateItem.Enabled = false;

            var versionItem = new ToolStripMenuItem("Version: " + AppVersion);
            versionItem.Enabled = false;

            var openItem = new ToolStripMenuItem("Open Router");
            openItem.Click += delegate { this.OpenRouter(); };

            var restartItem = new ToolStripMenuItem("Restart OpenCode");
            restartItem.Click += delegate { this.RestartOpenCode(); };

            var logItem = new ToolStripMenuItem("Open Log Folder");
            logItem.Click += delegate { this.OpenLogs(); };

            this.autostartItem = new ToolStripMenuItem("Run At Login");
            this.autostartItem.CheckOnClick = true;
            this.autostartItem.Checked = this.HasAutostart();
            this.autostartItem.Click += delegate { this.ToggleAutostart(); };

            var exitItem = new ToolStripMenuItem("Exit Launcher");
            exitItem.Click += delegate { this.ExitLauncher(); };

            var menu = new ContextMenuStrip();
            menu.Items.Add(this.stateItem);
            menu.Items.Add(versionItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(openItem);
            menu.Items.Add(restartItem);
            menu.Items.Add(logItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(this.autostartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            this.tray = new NotifyIcon();
            this.iconBase = LoadIcon(this.iconPath, this.exePath);
            this.iconRunning = TintIcon(this.iconBase, Color.FromArgb(76, 217, 100));
            this.iconStarting = TintIcon(this.iconBase, Color.FromArgb(60, 153, 255));
            this.iconWaiting = TintIcon(this.iconBase, Color.FromArgb(255, 184, 77));
            this.iconError = TintIcon(this.iconBase, Color.FromArgb(255, 92, 92));
            this.tray.Icon = this.iconStarting;
            this.tray.Visible = true;
            this.tray.Text = AppName;
            this.tray.ContextMenuStrip = menu;
            this.tray.DoubleClick += delegate { this.OpenRouter(); };

            this.timer = new Timer();
            this.timer.Interval = Math.Max(3, this.cfg.PollSeconds) * 1000;
            this.timer.Tick += delegate { this.Check(); };
            this.timer.Start();

            this.Log("launcher started");
            this.SetState("starting", "Launcher started");
            this.Check();
        }

        private void Check()
        {
            if (this.exiting || this.busy) return;
            this.busy = true;
            try
            {
                var next = FindTailIp();
                if (string.IsNullOrWhiteSpace(next))
                {
                    this.SetState("waiting", "Waiting for Tailscale IP");
                    return;
                }

                if (!string.IsNullOrWhiteSpace(this.host) && !string.Equals(this.host, next, StringComparison.OrdinalIgnoreCase))
                {
                    this.Log("tailscale ip changed from " + this.host + " to " + next);
                    KillMatching(this.host, this.cfg.Port);
                    this.child = null;
                }

                this.host = next;

                if (IsHealthy(this.host, this.cfg.Port, out this.version))
                {
                    this.SetState("running", "Running " + this.host + ":" + this.cfg.Port + " v" + this.version);
                    return;
                }

                if (this.child != null)
                {
                    try
                    {
                        if (!this.child.HasExited)
                        {
                            this.SetState("starting", "Starting OpenCode on " + this.host + ":" + this.cfg.Port);
                            return;
                        }
                    }
                    catch { }
                    this.child = null;
                }

                if ((DateTime.Now - this.lastStart).TotalSeconds < 3)
                {
                    this.SetState("starting", "Waiting before restart");
                    return;
                }

                this.StartOpenCode();
            }
            catch (Exception ex)
            {
                this.Log("check error: " + ex.Message);
                this.SetState("error", Trim(ex.Message));
            }
            finally
            {
                this.busy = false;
            }
        }

        private void StartOpenCode()
        {
            if (string.IsNullOrWhiteSpace(this.host)) return;
            if (!File.Exists(this.cfg.CliPath))
            {
                this.SetState("error", "OpenCode CLI not found");
                this.Log("cli not found at " + this.cfg.CliPath);
                return;
            }

            KillMatching(this.host, this.cfg.Port);
            var args = "web --hostname " + this.host + " --port " + this.cfg.Port + " --cors " + this.cfg.CorsOrigin;
            var info = new ProcessStartInfo();
            var ext = Path.GetExtension(this.cfg.CliPath).ToLowerInvariant();
            if (ext == ".cmd" || ext == ".bat")
            {
                info.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
                info.Arguments = "/c \"\"" + this.cfg.CliPath + "\" " + args + "\"";
            }
            else
            {
                info.FileName = this.cfg.CliPath;
                info.Arguments = args;
            }

            info.WorkingDirectory = this.root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables["BROWSER"] = "none";
            info.EnvironmentVariables["NO_PROXY"] = "localhost,127.0.0.1," + this.host;
            info.EnvironmentVariables["OPENCODE_CLIENT"] = "cli";
            info.EnvironmentVariables["OPENCODE_PID"] = string.Empty;
            info.EnvironmentVariables["OPENCODE_SERVER_PASSWORD"] = string.Empty;
            info.EnvironmentVariables["OPENCODE_SERVER_USERNAME"] = string.Empty;
            if (info.EnvironmentVariables.ContainsKey("XDG_STATE_HOME"))
            {
                info.EnvironmentVariables.Remove("XDG_STATE_HOME");
            }

            this.child = new Process();
            this.child.StartInfo = info;
            this.child.EnableRaisingEvents = true;
            this.child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (!string.IsNullOrWhiteSpace(e.Data)) this.Log("stdout " + e.Data); };
            this.child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (!string.IsNullOrWhiteSpace(e.Data)) this.Log("stderr " + e.Data); };
            this.child.Exited += delegate
            {
                this.Log("opencode exited");
                this.child = null;
            };

            this.child.Start();
            this.child.BeginOutputReadLine();
            this.child.BeginErrorReadLine();
            this.lastStart = DateTime.Now;
            this.Log("spawned opencode for " + this.host + ":" + this.cfg.Port);
            this.SetState("starting", "Starting OpenCode on " + this.host + ":" + this.cfg.Port);
        }

        private void RestartOpenCode()
        {
            try
            {
                var next = string.IsNullOrWhiteSpace(this.host) ? FindTailIp() : this.host;
                if (!string.IsNullOrWhiteSpace(next))
                {
                    KillMatching(next, this.cfg.Port);
                }
                this.child = null;
                this.Log("manual restart requested");
                this.Check();
            }
            catch (Exception ex)
            {
                this.Log("restart error: " + ex.Message);
                this.SetState("error", Trim(ex.Message));
            }
        }

        private void OpenRouter()
        {
            try
            {
                Process.Start(this.BuildRouterUrl());
            }
            catch (Exception ex)
            {
                this.Log("open router failed: " + ex.Message);
            }
        }

        private string BuildRouterUrl()
        {
            var nextHost = string.IsNullOrWhiteSpace(this.host) ? FindTailIp() : this.host;
            var raw = string.IsNullOrWhiteSpace(this.cfg.RouterUrl) ? "https://opencode.cosymart.top/?autogo=1" : this.cfg.RouterUrl.Trim();
            if (string.IsNullOrWhiteSpace(nextHost)) return raw;
            try
            {
                var builder = new UriBuilder(raw);
                var query = ParseQuery(builder.Query);
                query["host"] = nextHost;
                query["port"] = this.cfg.Port.ToString();
                if (!query.ContainsKey("autogo")) query["autogo"] = "1";
                builder.Query = BuildQuery(query);
                return builder.Uri.ToString();
            }
            catch
            {
                return raw;
            }
        }

        private static Dictionary<string, string> ParseQuery(string query)
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var text = string.IsNullOrWhiteSpace(query) ? string.Empty : query.TrimStart('?');
            if (text.Length == 0) return map;
            foreach (var pair in text.Split('&'))
            {
                if (string.IsNullOrWhiteSpace(pair)) continue;
                var i = pair.IndexOf('=');
                var key = i >= 0 ? pair.Substring(0, i) : pair;
                var value = i >= 0 ? pair.Substring(i + 1) : string.Empty;
                map[Uri.UnescapeDataString(key)] = Uri.UnescapeDataString(value);
            }
            return map;
        }

        private static string BuildQuery(Dictionary<string, string> values)
        {
            return string.Join("&", values.Select(functionPair => Uri.EscapeDataString(functionPair.Key) + "=" + Uri.EscapeDataString(functionPair.Value ?? string.Empty)));
        }

        private void OpenLogs()
        {
            try
            {
                Process.Start(this.logDir);
            }
            catch (Exception ex)
            {
                this.Log("open logs failed: " + ex.Message);
            }
        }

        private void ToggleAutostart()
        {
            var next = this.autostartItem.Checked;
            SetAutostart(next, this.exePath);
            this.cfg.AutoStart = next;
            this.cfg.Save(this.root);
            this.Log("autostart set to " + next);
        }

        private bool HasAutostart()
        {
            return GetAutostart(this.exePath);
        }

        private void ExitLauncher()
        {
            this.exiting = true;
            this.timer.Stop();
            this.tray.Visible = false;
            this.tray.Dispose();
            this.iconRunning.Dispose();
            this.iconStarting.Dispose();
            this.iconWaiting.Dispose();
            this.iconError.Dispose();
            this.iconBase.Dispose();
            this.Log("launcher exited");
            this.ExitThread();
        }

        private void SetState(string mode, string text)
        {
            this.stateItem.Text = "State: " + mode;
            this.tray.Icon = this.IconFor(mode);
            var tip = AppName + " " + AppVersion + " - " + text;
            if (tip.Length > 63) tip = tip.Substring(0, 63);
            this.tray.Text = tip;
        }

        private Icon IconFor(string mode)
        {
            if (string.Equals(mode, "running", StringComparison.OrdinalIgnoreCase)) return this.iconRunning;
            if (string.Equals(mode, "starting", StringComparison.OrdinalIgnoreCase)) return this.iconStarting;
            if (string.Equals(mode, "waiting", StringComparison.OrdinalIgnoreCase)) return this.iconWaiting;
            if (string.Equals(mode, "error", StringComparison.OrdinalIgnoreCase)) return this.iconError;
            return this.iconBase;
        }

        private void Log(string text)
        {
            var line = "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + text + Environment.NewLine;
            File.AppendAllText(this.logFile, line, Encoding.UTF8);
        }

        private static string Trim(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "unknown error";
            value = value.Replace("\r", " ").Replace("\n", " ").Trim();
            if (value.Length > 56) return value.Substring(0, 56);
            return value;
        }

        private static string FindTailIp()
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up) continue;
                var props = nic.GetIPProperties();
                foreach (var uni in props.UnicastAddresses)
                {
                    if (uni.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    var ip = uni.Address.ToString();
                    if (ip.StartsWith("100.", StringComparison.Ordinal)) return ip;
                }
            }
            return string.Empty;
        }

        private static bool IsHealthy(string host, int port, out string version)
        {
            version = string.Empty;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://" + host + ":" + port + "/global/health");
                req.Method = "GET";
                req.Timeout = 1500;
                req.ReadWriteTimeout = 1500;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var stream = new StreamReader(res.GetResponseStream()))
                {
                    var text = stream.ReadToEnd();
                    if (text.IndexOf("\"healthy\":true", StringComparison.OrdinalIgnoreCase) == -1) return false;
                    var match = Regex.Match(text, "\\\"version\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
                    if (match.Success) version = match.Groups[1].Value;
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void KillMatching(string host, int port)
        {
            if (string.IsNullOrWhiteSpace(host)) return;
            var ids = new List<int>();
            using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process"))
            using (var result = searcher.Get())
            {
                foreach (ManagementObject item in result)
                {
                    var line = Convert.ToString(item["CommandLine"]);
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    if (line.IndexOf("opencode", StringComparison.OrdinalIgnoreCase) == -1) continue;
                    if (line.IndexOf("web", StringComparison.OrdinalIgnoreCase) == -1) continue;
                    if (line.IndexOf("--hostname " + host, StringComparison.OrdinalIgnoreCase) == -1) continue;
                    if (line.IndexOf("--port " + port, StringComparison.OrdinalIgnoreCase) == -1) continue;
                    var pid = Convert.ToInt32(item["ProcessId"]);
                    if (pid > 0) ids.Add(pid);
                }
            }

            foreach (var pid in ids.Distinct())
            {
                try
                {
                    var info = new ProcessStartInfo("taskkill.exe", "/PID " + pid + " /T /F");
                    info.CreateNoWindow = true;
                    info.UseShellExecute = false;
                    using (var proc = Process.Start(info))
                    {
                        proc.WaitForExit(3000);
                    }
                }
                catch { }
            }
        }

        private static bool GetAutostart(string exePath)
        {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", false))
            {
                if (key == null) return false;
                var value = Convert.ToString(key.GetValue("OpenCodeTailnetLauncher"));
                return string.Equals(value, Quote(exePath), StringComparison.OrdinalIgnoreCase);
            }
        }

        internal static void SetAutostart(bool enabled, string exePath)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            {
                if (key == null) return;
                if (enabled) key.SetValue("OpenCodeTailnetLauncher", Quote(exePath));
                else key.DeleteValue("OpenCodeTailnetLauncher", false);
            }
        }

        private static string Quote(string value)
        {
            return "\"" + value + "\"";
        }

        private static Icon LoadIcon(string iconPath, string exePath)
        {
            try
            {
                if (File.Exists(iconPath)) return new Icon(iconPath);
            }
            catch { }

            try
            {
                var icon = Icon.ExtractAssociatedIcon(exePath);
                if (icon != null) return icon;
            }
            catch { }

            return SystemIcons.Application;
        }

        private static Icon TintIcon(Icon icon, Color color)
        {
            using (var bmp = icon.ToBitmap())
            using (var canvas = new Bitmap(16, 16))
            using (var g = Graphics.FromImage(canvas))
            {
                g.DrawImage(bmp, new Rectangle(0, 0, 16, 16));
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (var fill = new SolidBrush(color))
                using (var edge = new Pen(Color.FromArgb(230, 255, 255, 255), 1.4f))
                {
                    g.FillEllipse(fill, 9.0f, 9.0f, 6.0f, 6.0f);
                    g.DrawEllipse(edge, 9.0f, 9.0f, 6.0f, 6.0f);
                }
                var handle = canvas.GetHicon();
                try
                {
                    return (Icon)Icon.FromHandle(handle).Clone();
                }
                finally
                {
                    DestroyIcon(handle);
                }
            }
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);
    }

    internal sealed class Settings
    {
        public string CliPath;
        public int Port;
        public string CorsOrigin;
        public string RouterUrl;
        public int PollSeconds;
        public bool AutoStart;

        public static Settings Load(string root)
        {
            var file = Path.Combine(root, "oc-launcher.ini");
            var cfg = new Settings();
            cfg.CliPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm", "opencode.cmd");
            cfg.Port = 3000;
            cfg.CorsOrigin = "https://opencode.cosymart.top";
            cfg.RouterUrl = "https://opencode.cosymart.top/?autogo=1";
            cfg.PollSeconds = 5;
            cfg.AutoStart = false;

            if (File.Exists(file))
            {
                foreach (var raw in File.ReadAllLines(file))
                {
                    var line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    var i = line.IndexOf('=');
                    if (i < 0) continue;
                    var key = line.Substring(0, i).Trim().ToLowerInvariant();
                    var value = line.Substring(i + 1).Trim();
                    if (key == "cli_path" && value.Length > 0) cfg.CliPath = value;
                    else if (key == "port")
                    {
                        int port;
                        if (int.TryParse(value, out port) && port > 0 && port < 65536) cfg.Port = port;
                    }
                    else if (key == "cors_origin" && value.Length > 0) cfg.CorsOrigin = value;
                    else if (key == "router_url" && value.Length > 0) cfg.RouterUrl = value;
                    else if (key == "poll_seconds")
                    {
                        int poll;
                        if (int.TryParse(value, out poll) && poll >= 3) cfg.PollSeconds = poll;
                    }
                    else if (key == "auto_start")
                    {
                        cfg.AutoStart = value == "1" || value.Equals("true", StringComparison.OrdinalIgnoreCase);
                    }
                }
            }

            cfg.Save(root);
            return cfg;
        }

        public void Save(string root)
        {
            var file = Path.Combine(root, "oc-launcher.ini");
            var text = new StringBuilder();
            text.AppendLine("# OpenCode Tailnet Launcher");
            text.AppendLine("cli_path=" + this.CliPath);
            text.AppendLine("port=" + this.Port);
            text.AppendLine("cors_origin=" + this.CorsOrigin);
            text.AppendLine("router_url=" + this.RouterUrl);
            text.AppendLine("poll_seconds=" + this.PollSeconds);
            text.AppendLine("auto_start=" + (this.AutoStart ? "true" : "false"));
            File.WriteAllText(file, text.ToString(), Encoding.UTF8);
        }
    }
}

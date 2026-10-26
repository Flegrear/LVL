// Native update companion for the installed public LVL launcher.
// Compile alongside Launcher.cs, referencing System.Web.Extensions.dll.
// Never uses the private Language Video Learner releases, folders or registry keys.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace LanguageVideoLearner
{
    internal sealed class PackagedUpdater
    {
        private const string ReleasesUrl = "https://api.github.com/repos/Flegrear/LVL/releases?per_page=20";
        private const string ReleaseAssetsPrefix = "https://github.com/Flegrear/LVL/releases/download/";
        private const int MaxJsonBytes = 524288;
        private const int AutomaticCheckIntervalDays = 1;
        private readonly object gate = new object();
        private readonly string root;
        private readonly string preferencesFile;
        private readonly Log log;
        private readonly Control invoker;
        private readonly Action<string> notify;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly string installedVersion;
        private ToolStripMenuItem checkItem;
        private ToolStripMenuItem installItem;
        private TcpListener bridge;
        private string secret;
        private bool automatic;
        private int intervalDays = AutomaticCheckIntervalDays;
        private DateTime lastCheckedUtc = DateTime.MinValue;
        private bool checking;
        private bool downloading;
        private bool noticePending;
        private string error;
        private Release available;
        private readonly System.Threading.Timer recurringChecks;

        private sealed class Release
        {
            public string Version;
            public string SetupName;
            public string SetupUrl;
            public string ChecksumUrl;
            public bool IsPatch;
        }

        public static bool IsInstalled(string appRoot)
        {
            return !string.IsNullOrEmpty(appRoot) && File.Exists(Path.Combine(appRoot, "installed-app.json"));
        }

        public PackagedUpdater(string appRoot, Log appLog, Control owner, Action<string> onNotice)
        {
            root = Path.GetFullPath(appRoot);
            log = appLog;
            invoker = owner;
            notify = onNotice;
            installedVersion = ReadInstalledVersion();
            string dataRoot = Path.GetDirectoryName(Path.GetDirectoryName(log.FilePath));
            preferencesFile = Path.Combine(dataRoot, "lvl-update-settings.json");
            LoadSettings();
            // A tray app can run for days: re-evaluate the saved automatic
            // cadence hourly instead of checking only at launcher startup.
            recurringChecks = new System.Threading.Timer(delegate { CheckOnStartup(); }, null,
                TimeSpan.FromHours(1), TimeSpan.FromHours(1));
        }

        public void AddTo(ContextMenuStrip menu)
        {
            checkItem = new ToolStripMenuItem("Check for LVL updates", null, delegate { StartCheck(true); });
            installItem = new ToolStripMenuItem("Install available LVL update…", null, delegate { StartInstall(false); });
            installItem.Visible = false;
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(checkItem);
            menu.Items.Add(installItem);
            RefreshMenu();
        }

        public void CheckOnStartup()
        {
            lock (gate)
            {
                if (!automatic || lastCheckedUtc.AddDays(intervalDays) > DateTime.UtcNow) return;
            }
            StartCheck(false);
        }

        // Exposed only over 127.0.0.1 with an unpredictable per-launch secret.
        // The browser does not receive either endpoint or secret. The Node
        // server receives them as a private child-process environment variable.
        public string BeginBridge()
        {
            lock (gate)
            {
                if (bridge != null) return ((IPEndPoint)bridge.LocalEndpoint).Port + ":" + secret;
                byte[] random = new byte[32];
                using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(random);
                secret = Convert.ToBase64String(random);
                bridge = new TcpListener(IPAddress.Loopback, 0);
                bridge.Start(4);
                ThreadPool.QueueUserWorkItem(delegate { AcceptConnections(); });
                return ((IPEndPoint)bridge.LocalEndpoint).Port + ":" + secret;
            }
        }

        public void EndBridge()
        {
            lock (gate)
            {
                if (bridge != null)
                {
                    bridge.Stop();
                    bridge = null;
                }
                secret = null;
            }
        }

        private void AcceptConnections()
        {
            while (true)
            {
                TcpClient client;
                try
                {
                    TcpListener listener;
                    lock (gate) listener = bridge;
                    if (listener == null) return;
                    client = listener.AcceptTcpClient();
                }
                catch (SocketException) { return; }
                catch (ObjectDisposedException) { return; }
                ThreadPool.QueueUserWorkItem(delegate { Answer(client); });
            }
        }

        private void Answer(TcpClient client)
        {
            using (client)
            {
                try
                {
                    client.ReceiveTimeout = 3000;
                    client.SendTimeout = 3000;
                    NetworkStream stream = client.GetStream();
                    MemoryStream bytes = new MemoryStream();
                    while (bytes.Length < 4096)
                    {
                        int ch = stream.ReadByte();
                        if (ch == 10) break;
                        if (ch < 0) return;
                        bytes.WriteByte((byte)ch);
                    }
                    if (bytes.Length >= 4096) return;
                    Dictionary<string, object> command = json.Deserialize<Dictionary<string, object>>(
                        Encoding.UTF8.GetString(bytes.ToArray()));
                    string received = Value(command, "secret");
                    string actual;
                    lock (gate) actual = secret;
                    if (string.IsNullOrEmpty(actual) || !EqualSecret(received, actual)) return;
                    object result = HandleCommand(command);
                    byte[] response = Encoding.UTF8.GetBytes(json.Serialize(result) + "\n");
                    stream.Write(response, 0, response.Length);
                }
                catch (Exception failure)
                {
                    log.Write("updater", "Update request failed: " + failure.GetType().Name);
                }
            }
        }

        private static bool EqualSecret(string received, string expected)
        {
            if (received == null || expected == null || received.Length != expected.Length) return false;
            int difference = 0;
            for (int i = 0; i < expected.Length; i++) difference |= received[i] ^ expected[i];
            return difference == 0;
        }

        private object HandleCommand(Dictionary<string, object> command)
        {
            switch (Value(command, "action"))
            {
                case "status": return Status();
                case "settings":
                    object flag;
                    object frequency;
                    int interval;
                    if (!command.TryGetValue("automatic", out flag) || !(flag is bool) ||
                        !command.TryGetValue("intervalDays", out frequency) || !int.TryParse(Convert.ToString(frequency), out interval) ||
                        (interval != 1 && interval != 7 && interval != 30))
                        return new { error = "Invalid update preferences" };
                    bool changedToAutomatic;
                    lock (gate)
                    {
                        changedToAutomatic = !automatic && (bool)flag;
                        automatic = (bool)flag;
                        // Frequency is no longer configurable. Still accept
                        // legacy bridge payloads but always schedule daily.
                        intervalDays = AutomaticCheckIntervalDays;
                        SaveSettings();
                    }
                    if (changedToAutomatic) StartCheck(false);
                    return Status();
                case "check":
                    // A notification-only background poll is not the same as a
                    // user pressing Check for updates. Auto-apply only on a
                    // direct manual request or when automatic updates are on.
                    object applyRequested;
                    bool userRequestedApply = command.TryGetValue("apply", out applyRequested)
                        && applyRequested is bool && (bool)applyRequested;
                    StartCheck(userRequestedApply);
                    return Status();
                case "install": return StartInstall(false) ? Status() : new { error = "No verified LVL update is ready to install" };
                default: return new { error = "Unknown updater action" };
            }
        }

        private static string Value(Dictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) && value is string ? (string)value : null;
        }

        private object Status()
        {
            lock (gate)
            {
                return new {
                    installed = true, enabled = true, automatic, intervalDays,
                    lastCheckedAt = lastCheckedUtc == DateTime.MinValue ? null : lastCheckedUtc.ToString("o"),
                    installedVersion,
                    available = available != null,
                    availableVersion = available == null ? null : available.Version,
                    checking, downloading, error,
                    notice = available == null ? null : new { message = "LVL " + available.Version + " is available" },
                    noticePending,
                };
            }
        }

        private void StartCheck(bool initiatedManually)
        {
            lock (gate)
            {
                if (checking || downloading) return;
                checking = true;
                error = null;
            }
            RefreshMenu();
            ThreadPool.QueueUserWorkItem(delegate
            {
                Release found = null;
                string failure = null;
                try { found = FindRelease(); }
                catch (Exception issue) { failure = issue.Message; }
                lock (gate)
                {
                    checking = false;
                    lastCheckedUtc = DateTime.UtcNow;
                    error = failure;
                    if (failure == null)
                    {
                        bool isNew = found != null && (available == null || available.Version != found.Version);
                        available = found;
                        noticePending = found != null && (noticePending || isNew);
                    }
                    SaveSettings();
                }
                RefreshMenu();
                // Both patch and full releases install after an opted-in
                // automatic check or an explicitly requested manual check.
                // Notification-only checks are read-only.
                if (failure == null && found != null)
                {
                    bool shouldApply;
                    lock (gate) shouldApply = automatic || initiatedManually;
                    if (shouldApply) StartInstall(true);
                }
                if (failure != null) log.Write("updater", "Update check failed: " + failure);
                else if (found != null) log.Write("updater", "Available public LVL release: " + found.Version);
            });
        }

        private bool StartInstall(bool autoApply)
        {
            Release selected;
            lock (gate)
            {
                if (checking || downloading || available == null || string.IsNullOrEmpty(available.ChecksumUrl)) return false;
                selected = available;
                downloading = true;
                error = null;
            }
            RefreshMenu();
            OnUi(delegate
            {
                if (!autoApply && !selected.IsPatch && MessageBox.Show("Download and install LVL " + selected.Version + "? The installer will ask for confirmation.",
                    "LVL Update", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                {
                    lock (gate) downloading = false;
                    RefreshMenu();
                    return;
                }
                ThreadPool.QueueUserWorkItem(delegate { DownloadAndRun(selected, autoApply); });
            });
            return true;
        }

        private void DownloadAndRun(Release release, bool autoApply)
        {
            string folder = Path.Combine(Path.GetTempPath(), "LVL-update-" + Guid.NewGuid().ToString("N"));
            string setupPath = Path.Combine(folder, release.SetupName);
            try
            {
                Directory.CreateDirectory(folder);
                string checksums = Encoding.UTF8.GetString(ReadBounded(release.ChecksumUrl, 65536));
                string expected = ParseSha256(checksums, release.SetupName);
                if (expected == null) throw new InvalidDataException("Release has no matching SHA-256 checksum");
                DownloadInstaller(release.SetupUrl, setupPath, release.IsPatch);
                string actual;
                using (SHA256 digest = SHA256.Create())
                using (FileStream file = File.OpenRead(setupPath)) actual = BitConverter.ToString(digest.ComputeHash(file)).Replace("-", "");
                if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Downloaded setup failed SHA-256 verification");
                OnUi(delegate
                {
                    try
                    {
                        if (release.IsPatch)
                        {
                            string node = Path.Combine(root, "runtime", "node.exe");
                            string helper = Path.Combine(root, "runtime", "update-apply.mjs");
                            if (!File.Exists(node) || !File.Exists(helper))
                                throw new InvalidDataException("This installation needs the patch-capable LVL bootstrap installer");
                            string arguments = Quote(helper)
                                + " --zip " + Quote(setupPath)
                                + " --zip-sha256 " + Quote(expected)
                                + " --app-root " + Quote(root)
                                + " --from " + Quote(installedVersion)
                                + " --to " + Quote(release.Version)
                                + " --parent-pid " + Process.GetCurrentProcess().Id
                                + " --relaunch";
                            Process.Start(new ProcessStartInfo(node, arguments) {
                                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                            });
                        }
                        else
                        {
                            // Full setup is only needed for launcher/runtime/
                            // dependency changes. In an explicitly opted-in
                            // automatic update run silently, stop only this
                            // public launcher, then restart the new app.
                            string flags = autoApply
                                ? "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LVLRestart=1"
                                : "";
                            Process.Start(new ProcessStartInfo(setupPath, flags) { UseShellExecute = true });
                        }
                        lock (gate) noticePending = false;
                        log.Write("updater", "Launched verified LVL update " + release.Version);
                    }
                    catch (Exception issue)
                    {
                        lock (gate) error = "Could not open the verified installer: " + issue.Message;
                        notify("LVL update could not start. Check the launcher log.");
                    }
                    finally { lock (gate) downloading = false; RefreshMenu(); }
                });
            }
            catch (Exception issue)
            {
                lock (gate) { error = issue.Message; downloading = false; }
                log.Write("updater", "Could not download and validate LVL update: " + issue.Message);
                OnUi(delegate { notify("LVL update download failed. See the launcher log."); RefreshMenu(); });
                try { Directory.Delete(folder, true); } catch (Exception) { }
            }
        }

        private static string Quote(string path)
        {
            return "\"" + path.Replace("\"", "\\\"") + "\"";
        }

        private void RefreshMenu()
        {
            OnUi(delegate
            {
                lock (gate)
                {
                    if (checkItem != null)
                    {
                        checkItem.Enabled = !checking && !downloading;
                        checkItem.Text = checking ? "Checking for LVL updates…" : "Check for LVL updates";
                    }
                    if (installItem != null)
                    {
                        installItem.Visible = available != null;
                        installItem.Enabled = available != null && !checking && !downloading && !string.IsNullOrEmpty(available.ChecksumUrl);
                        installItem.Text = available == null ? "Install available LVL update…" : "Install LVL " + available.Version + "…";
                    }
                }
            });
        }

        private void OnUi(MethodInvoker action)
        {
            try
            {
                if (invoker.IsDisposed) return;
                if (invoker.InvokeRequired) invoker.BeginInvoke(action);
                else action();
            }
            catch (InvalidOperationException) { }
        }

        private Release FindRelease()
        {
            // A freshly launched Windows process can hit a transient DNS/TLS
            // connection or GitHub gateway failure on its first request. Retry
            // the read-only feed lookup here so the user does not need to press
            // Check for updates a second time. Never retry malformed metadata,
            // invalid TLS certificates, authorization or other hard failures.
            object[] releases = json.DeserializeObject(Encoding.UTF8.GetString(ReadReleaseFeed(
                delegate { return ReadBounded(ReleasesUrl, MaxJsonBytes); }, Thread.Sleep))) as object[];
            if (releases == null) throw new InvalidDataException("Invalid LVL release feed");
            Release next = null;
            foreach (object item in releases)
            {
                Dictionary<string, object> release = item as Dictionary<string, object>;
                if (release == null || Flag(release, "draft")) continue;
                string version = Value(release, "tag_name");
                // The public channel accepts only exact release versions, not
                // rc tags or similarly named unversioned release assets.
                if (!Regex.IsMatch(version ?? "", @"\A[vV]?\d+\.\d+\.\d+\z")) continue;
                if (CompareVersions(version, installedVersion) <= 0) continue;
                object entries;
                if (!release.TryGetValue("assets", out entries)) continue;
                object[] assets = entries as object[];
                if (assets == null) continue;
                string setupName = null, setupUrl = null, checksumUrl = null;
                bool patch = false;
                bool patchSupported = File.Exists(Path.Combine(root, "runtime", "update-apply.mjs"));
                if (patchSupported)
                {
                    foreach (object assetEntry in assets)
                    {
                        Dictionary<string, object> asset = assetEntry as Dictionary<string, object>;
                        if (asset == null) continue;
                        string name = Value(asset, "name");
                        string url = Value(asset, "browser_download_url");
                        if (name != null && name.Equals("LVL-update-v" + version.TrimStart('v', 'V') + ".zip", StringComparison.OrdinalIgnoreCase)
                            && ValidAssetUrl(url))
                        { setupName = name; setupUrl = url; patch = true; break; }
                    }
                }
                foreach (object assetEntry in assets)
                {
                    if (setupName != null) break;
                    Dictionary<string, object> asset = assetEntry as Dictionary<string, object>;
                    if (asset == null) continue;
                    string name = Value(asset, "name");
                    string url = Value(asset, "browser_download_url");
                    if (name != null && name.Equals("LVL-Setup.exe", StringComparison.OrdinalIgnoreCase) && ValidAssetUrl(url))
                    { setupName = name; setupUrl = url; break; }
                }
                if (setupName == null) continue;
                foreach (object assetEntry in assets)
                {
                    Dictionary<string, object> asset = assetEntry as Dictionary<string, object>;
                    if (asset == null) continue;
                    string name = Value(asset, "name");
                    string url = Value(asset, "browser_download_url");
                    if (!ValidAssetUrl(url) || name == null) continue;
                    if (name.Equals(setupName + ".sha256", StringComparison.OrdinalIgnoreCase) ||
                        Regex.IsMatch(name, @"^(?:SHA256SUMS(?:\.txt)?|checksums\.txt)$", RegexOptions.IgnoreCase))
                    { checksumUrl = url; break; }
                }
                // An unsigned/unchecked setup is never offered for installation.
                if (checksumUrl == null) continue;
                Release candidate = new Release {
                    Version = version.TrimStart('v', 'V'), SetupName = setupName,
                    SetupUrl = setupUrl, ChecksumUrl = checksumUrl, IsPatch = patch,
                };
                // Deltas are built against exactly one previous release. Apply
                // versions in ascending order rather than skipping over a base.
                if (next == null || CompareVersions(candidate.Version, next.Version) < 0) next = candidate;
            }
            return next;
        }

        private static bool Flag(Dictionary<string, object> obj, string key)
        {
            object value;
            return obj.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        private static bool ValidAssetUrl(string url)
        {
            Uri parsed;
            return !string.IsNullOrEmpty(url) && url.StartsWith(ReleaseAssetsPrefix, StringComparison.OrdinalIgnoreCase)
                && Uri.TryCreate(url, UriKind.Absolute, out parsed);
        }

        private static int CompareVersions(string left, string right)
        {
            Match a = Regex.Match(left ?? "", @"^[vV]?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$");
            Match b = Regex.Match(right ?? "", @"^[vV]?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$");
            if (!a.Success || !b.Success) return -1;
            for (int i = 1; i <= 3; i++)
            {
                int x, y;
                if (!int.TryParse(a.Groups[i].Value, out x) || !int.TryParse(b.Groups[i].Value, out y)) return -1;
                if (x != y) return x.CompareTo(y);
            }
            return 0;
        }

        private static string ParseSha256(string content, string setupName)
        {
            string only = content.Trim();
            if (Regex.IsMatch(only, @"\A[a-fA-F0-9]{64}\z")) return only;
            foreach (string line in content.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                Match match = Regex.Match(line, @"^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$", RegexOptions.IgnoreCase);
                if (match.Success && match.Groups[2].Value == setupName) return match.Groups[1].Value;
            }
            return null;
        }

        private static bool TransientReleaseError(Exception issue)
        {
            WebException network = issue as WebException;
            if (network != null)
            {
                if (network.Status == WebExceptionStatus.Timeout || network.Status == WebExceptionStatus.ConnectFailure ||
                    network.Status == WebExceptionStatus.NameResolutionFailure || network.Status == WebExceptionStatus.ProxyNameResolutionFailure ||
                    network.Status == WebExceptionStatus.SendFailure || network.Status == WebExceptionStatus.ReceiveFailure ||
                    network.Status == WebExceptionStatus.ConnectionClosed || network.Status == WebExceptionStatus.KeepAliveFailure ||
                    network.Status == WebExceptionStatus.PipelineFailure) return true;
                if (network.Status == WebExceptionStatus.ProtocolError)
                {
                    HttpWebResponse response = network.Response as HttpWebResponse;
                    int code = response == null ? 0 : (int)response.StatusCode;
                    return code == 408 || code == 500 || code == 502 || code == 503 || code == 504;
                }
                return false;
            }
            return issue is IOException && !(issue is InvalidDataException);
        }

        // A bounded, side-effect-free retry; supplied callbacks keep native
        // regression tests deterministic without reaching GitHub or an install.
        private static byte[] ReadReleaseFeed(Func<byte[]> read, Action<int> pause)
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try { return read(); }
                catch (Exception issue)
                {
                    if (attempt == 2 || !TransientReleaseError(issue)) throw;
                }
                pause(250 * (attempt + 1));
            }
            throw new InvalidOperationException("Could not read the LVL release feed");
        }

        private static byte[] ReadBounded(string url, int limit)
        {
            if (!url.Equals(ReleasesUrl, StringComparison.Ordinal) && !ValidAssetUrl(url))
                throw new InvalidOperationException("Invalid LVL update URL");
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.UserAgent = "LVL-Windows-Launcher/0.1";
            request.Accept = "application/vnd.github+json, */*";
            request.Timeout = 12000;
            request.ReadWriteTimeout = 12000;
            request.AutomaticDecompression = DecompressionMethods.Deflate | DecompressionMethods.GZip;
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
            using (WebResponse response = request.GetResponse())
            using (Stream remote = response.GetResponseStream())
            using (MemoryStream output = new MemoryStream())
            {
                byte[] buffer = new byte[16384];
                int n;
                while ((n = remote.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (output.Length + n > limit) throw new InvalidDataException("LVL update metadata is too large");
                    output.Write(buffer, 0, n);
                }
                return output.ToArray();
            }
        }

        private static void DownloadInstaller(string url, string destination, bool isPatch)
        {
            if (!ValidAssetUrl(url)) throw new InvalidOperationException("Invalid LVL setup URL");
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.UserAgent = "LVL-Windows-Launcher/0.1";
            request.Timeout = 20000;
            request.ReadWriteTimeout = 20000;
            using (WebResponse response = request.GetResponse())
            using (Stream input = response.GetResponseStream())
            using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                byte[] buffer = new byte[65536];
                long total = 0;
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    total += read;
                    if (total > (isPatch ? 128L : 1024L) * 1024 * 1024)
                        throw new InvalidDataException("LVL update download is unexpectedly large");
                    output.Write(buffer, 0, read);
                }
                if (total < (isPatch ? 100 : 1024 * 1024))
                    throw new InvalidDataException("LVL update download is unexpectedly small");
            }
        }

        private string ReadInstalledVersion()
        {
            try
            {
                string package = File.ReadAllText(Path.Combine(root, "package.json"));
                Dictionary<string, object> info = json.Deserialize<Dictionary<string, object>>(package);
                string version = Value(info, "version");
                if (Regex.IsMatch(version ?? "", @"^\d+\.\d+\.\d+$")) return version;
            }
            catch (Exception) { }
            return "0.1.0";
        }

        private void LoadSettings()
        {
            try
            {
                if (!File.Exists(preferencesFile)) return;
                Dictionary<string, object> settings = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(preferencesFile));
                object value;
                if (settings.TryGetValue("automatic", out value) && value is bool) automatic = (bool)value;
                // Old installs may contain 7/30-day preferences. Normalize
                // them in memory so enabling automatic updates always uses
                // the same once-daily preset, regardless of past selections.
                intervalDays = AutomaticCheckIntervalDays;
                if (settings.TryGetValue("lastCheckedAt", out value) && value is string)
                {
                    DateTime parsed;
                    if (DateTime.TryParse((string)value, null, System.Globalization.DateTimeStyles.RoundtripKind, out parsed)) lastCheckedUtc = parsed.ToUniversalTime();
                }
            }
            catch (Exception failure) { log.Write("updater", "Could not read update settings: " + failure.GetType().Name); }
        }

        private void SaveSettings()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(preferencesFile));
                string data = json.Serialize(new {
                    automatic, intervalDays,
                    lastCheckedAt = lastCheckedUtc == DateTime.MinValue ? null : lastCheckedUtc.ToString("o")
                });
                string pending = preferencesFile + ".tmp";
                File.WriteAllText(pending, data, Encoding.UTF8);
                if (File.Exists(preferencesFile)) File.Replace(pending, preferencesFile, null);
                else File.Move(pending, preferencesFile);
            }
            catch (Exception failure) { log.Write("updater", "Could not save update settings: " + failure.GetType().Name); }
        }
    }
}

// Native update companion for the installed public LVL launcher.
// Compile alongside Launcher.cs, referencing System.Web.Extensions.dll.
// Uses only LVL's own GitHub releases.
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
        private const int ReleasesPerPage = 20;
        private const int MaxReleasePages = 10;
        private const string ReleaseAssetsPrefix = "https://github.com/Flegrear/LVL/releases/download/";
        private const int MaxJsonBytes = 524288;
        private const int AutomaticCheckIntervalDays = 1;
        // Every update installs without the Setup wizard and restarts LVL afterwards.
        private const string SilentSetupArguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LVLRestart=1";
        // Each download goes to %TEMP%\LVL-update-<Guid "N">; nothing else matches.
        private static readonly Regex UpdateFolderName = new Regex(@"\ALVL-update-[0-9a-f]{32}\z", RegexOptions.CultureInvariant);
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
        private System.Threading.Timer leftoverRetry;
        private string activeUpdateFolder;

        private sealed class Release
        {
            public string Version;
            public string SetupName;
            public string SetupUrl;
            public string ChecksumUrl;
            public bool IsPatch;
            public string PayloadHash, ChecksumHash;
            public long PayloadSize, ChecksumSize;
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
            ScheduleLeftoverCleanup();
            lock (gate)
            {
                if (!automatic || lastCheckedUtc.AddDays(intervalDays) > DateTime.UtcNow) return;
            }
            StartCheck(false);
        }

        // Runs at startup, again 3 minutes later (the setup that restarted LVL
        // may still be closing) and hourly with the update check.
        private void ScheduleLeftoverCleanup()
        {
            ThreadPool.QueueUserWorkItem(delegate { CleanUpdateLeftovers(); });
            lock (gate)
            {
                if (leftoverRetry != null) return;
                leftoverRetry = new System.Threading.Timer(delegate { CleanUpdateLeftovers(); }, null,
                    TimeSpan.FromMinutes(3), TimeSpan.FromMilliseconds(-1));
            }
        }

        private void CleanUpdateLeftovers()
        {
            string keep;
            lock (gate) keep = activeUpdateFolder;
            int removed = RemoveUpdateLeftovers(Path.GetTempPath(), keep, DateTime.UtcNow.AddMinutes(-2));
            if (removed > 0) log.Write("updater", "Removed " + removed + " finished update download folder(s)");
        }

        // Deletes finished update downloads directly inside tempRoot. Only exact
        // LVL-update-<32 hex> folders, never links, never the one in use or one
        // changed after olderThanUtc. A folder a running setup still holds fails
        // to delete and is retried on the next pass.
        private static int RemoveUpdateLeftovers(string tempRoot, string keep, DateTime olderThanUtc)
        {
            int removed = 0;
            string[] folders;
            try { folders = Directory.GetDirectories(tempRoot); }
            catch (Exception) { return 0; }
            foreach (string folder in folders)
            {
                if (!UpdateFolderName.IsMatch(Path.GetFileName(folder))) continue;
                try
                {
                    if (keep != null && string.Equals(Path.GetFullPath(folder), Path.GetFullPath(keep), StringComparison.OrdinalIgnoreCase)) continue;
                    DirectoryInfo info = new DirectoryInfo(folder);
                    if ((info.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                    if (info.LastWriteTimeUtc > olderThanUtc) continue;
                    info.Delete(true);
                    removed++;
                }
                catch (Exception) { }
            }
            return removed;
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
            // Pressing Install (or an automatic update) is the confirmation:
            // patches and full setups both install without further prompts.
            ThreadPool.QueueUserWorkItem(delegate { DownloadAndRun(selected); });
            return true;
        }

        private void DownloadAndRun(Release release)
        {
            string folder = Path.Combine(Path.GetTempPath(), "LVL-update-" + Guid.NewGuid().ToString("N"));
            string setupPath = Path.Combine(folder, release.SetupName);
            lock (gate) activeUpdateFolder = folder;
            try
            {
                Directory.CreateDirectory(folder);
                byte[] checksumBytes = ReadBounded(release.ChecksumUrl, 65536);
                VerifyPinnedBytes(checksumBytes, release.ChecksumSize, release.ChecksumHash);
                string checksums = Encoding.UTF8.GetString(checksumBytes);
                string expected = ParseSha256(checksums, release.SetupName);
                if (release.PayloadHash != null && !release.PayloadHash.Equals(expected, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Release checksum disagrees with manifest");
                if (expected == null) throw new InvalidDataException("Release has no matching SHA-256 checksum");
                DownloadInstaller(release.SetupUrl, setupPath, release.IsPatch);
                string actual;
                using (SHA256 digest = SHA256.Create())
                using (FileStream file = File.OpenRead(setupPath)) actual = BitConverter.ToString(digest.ComputeHash(file)).Replace("-", "");
                if ((release.PayloadHash != null && (new FileInfo(setupPath).Length != release.PayloadSize || !actual.Equals(release.PayloadHash, StringComparison.OrdinalIgnoreCase))) || !actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
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
                            // dependency changes. It runs silently, stops only
                            // this public launcher, then restarts the new app.
                            Process.Start(new ProcessStartInfo(setupPath, SilentSetupArguments) { UseShellExecute = true });
                        }
                        lock (gate) noticePending = false;
                        log.Write("updater", "Launched verified LVL update " + release.Version);
                    }
                    catch (Exception issue)
                    {
                        lock (gate) { error = "Could not open the verified installer: " + issue.Message; activeUpdateFolder = null; }
                        notify("LVL update could not start. Check the launcher log.");
                        try { Directory.Delete(folder, true); } catch (Exception) { }
                    }
                    finally { lock (gate) downloading = false; RefreshMenu(); }
                });
            }
            catch (Exception issue)
            {
                lock (gate) { error = issue.Message; downloading = false; activeUpdateFolder = null; }
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
            return FindReleaseWithManifest(installedVersion, File.Exists(Path.Combine(root, "runtime", "update-apply.mjs")),
                delegate(int page) { return ReadBounded(ReleasePageUrl(page), MaxJsonBytes); }, delegate(string url) { return ReadBounded(url, 65536); }, Thread.Sleep);
        }

        private static string ReleasePageUrl(int page)
        {
            if (page < 1 || page > MaxReleasePages) throw new ArgumentOutOfRangeException("page");
            return page == 1 ? ReleasesUrl : ReleasesUrl + "&page=" + page;
        }

        private static bool ValidReleaseFeedUrl(string url)
        {
            for (int page = 1; page <= MaxReleasePages; page++)
                if (string.Equals(url, ReleasePageUrl(page), StringComparison.Ordinal)) return true;
            return false;
        }

        // Scan all available pages: newer releases can be interleaved with
        // Android/native tags, while sequential patches require the LOWEST
        // newer Windows version, even when it is on an older GitHub page.
        // Supplied readers allow isolated native tests without network access.
        private static Release FindRelease(string installed, bool patchSupported,
            Func<int, byte[]> readPage, Action<int> pause)
        {
            return FindReleaseWithManifest(installed, patchSupported, readPage,
                delegate(string url) { return ReadBounded(url, 65536); }, pause);
        }

        private static Release FindReleaseWithManifest(string installed, bool patchSupported,
            Func<int, byte[]> readPage, Func<string, byte[]> readManifest, Action<int> pause)
        {
            Release next = null;
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            for (int page = 1; page <= MaxReleasePages; page++)
            {
                // Retry only transient reads, for each page independently.
                // Never convert a failed or malformed later page to UpToDate.
                byte[] body = ReadReleaseFeed(delegate { return readPage(page); }, pause);
                object[] releases;
                try { releases = serializer.DeserializeObject(Encoding.UTF8.GetString(body)) as object[]; }
                catch (ArgumentException issue) { throw new InvalidDataException("Invalid LVL release feed", issue); }
                catch (InvalidOperationException issue) { throw new InvalidDataException("Invalid LVL release feed", issue); }
                if (releases == null || releases.Length > ReleasesPerPage)
                    throw new InvalidDataException("Invalid LVL release feed");
                foreach (object item in releases)
                {
                    Dictionary<string, object> release = item as Dictionary<string, object>;
                    if (release == null) throw new InvalidDataException("Invalid LVL release feed");
                    object draft, prerelease;
                    if (!release.TryGetValue("draft", out draft) || !(draft is bool) ||
                        !release.TryGetValue("prerelease", out prerelease) || !(prerelease is bool))
                        throw new InvalidDataException("Invalid LVL release feed");
                    // Never offer drafts or prereleases on the stable channel.
                    if ((bool)draft || (bool)prerelease) continue;
                    string tag = Value(release, "tag_name");
                    if (tag == null) throw new InvalidDataException("Invalid LVL release feed");
                    if (CombinedTag(tag))
                    {
                        Release combined = ReadCombinedRelease(release, tag, readManifest, pause);
                        if (combined != null && CompareVersions(combined.Version, installed) > 0 && (!combined.IsPatch || patchSupported)
                            && (next == null || CompareVersions(combined.Version, next.Version) < 0)) next = combined;
                        continue;
                    }
                    // Only canonical Windows tags: Android/native/rc tags are not updates.
                    if (!Regex.IsMatch(tag, @"\Av\d+\.\d+\.\d+\z")) continue;
                    string version = tag.Substring(1);
                    if (CompareVersions(version, version) != 0)
                        throw new InvalidDataException("Invalid LVL release feed: unrepresentable Windows version");
                    if (CompareVersions(version, installed) <= 0) continue;
                    object entries;
                    if (!release.TryGetValue("assets", out entries) || !(entries is object[]))
                        throw new InvalidDataException("Invalid LVL release feed");
                    object[] assets = (object[])entries;
                    string setupName = null, setupUrl = null, checksumUrl = null;
                    bool patch = false;
                    foreach (object assetEntry in assets)
                        if (!(assetEntry is Dictionary<string, object>))
                            throw new InvalidDataException("Invalid LVL release feed");
                    if (patchSupported)
                    {
                        foreach (object assetEntry in assets)
                        {
                            Dictionary<string, object> asset = (Dictionary<string, object>)assetEntry;
                            string name = Value(asset, "name");
                            string url = Value(asset, "browser_download_url");
                            if (name != null && name.Equals("LVL-update-v" + version + ".zip", StringComparison.OrdinalIgnoreCase)
                                && ValidReleaseAssetUrl(url, tag, name))
                            { setupName = name; setupUrl = url; patch = true; break; }
                        }
                    }
                    foreach (object assetEntry in assets)
                    {
                        if (setupName != null) break;
                        Dictionary<string, object> asset = (Dictionary<string, object>)assetEntry;
                        string name = Value(asset, "name");
                        string url = Value(asset, "browser_download_url");
                        if (name != null && name.Equals("LVL-Setup.exe", StringComparison.OrdinalIgnoreCase)
                            && ValidReleaseAssetUrl(url, tag, name))
                        { setupName = name; setupUrl = url; break; }
                    }
                    if (setupName == null) continue;
                    foreach (object assetEntry in assets)
                    {
                        Dictionary<string, object> asset = (Dictionary<string, object>)assetEntry;
                        string name = Value(asset, "name");
                        string url = Value(asset, "browser_download_url");
                        if (name == null || !ValidReleaseAssetUrl(url, tag, name)) continue;
                        if (name.Equals(setupName + ".sha256", StringComparison.OrdinalIgnoreCase) ||
                            Regex.IsMatch(name, @"^(?:SHA256SUMS(?:\.txt)?|checksums\.txt)$", RegexOptions.IgnoreCase))
                        { checksumUrl = url; break; }
                    }
                    // Never offer an update without a verified checksum asset.
                    if (checksumUrl == null) continue;
                    Release candidate = new Release {
                        Version = version, SetupName = setupName,
                        SetupUrl = setupUrl, ChecksumUrl = checksumUrl, IsPatch = patch,
                    };
                    if (next == null || CompareVersions(candidate.Version, next.Version) < 0) next = candidate;
                }
                if (releases.Length < ReleasesPerPage) return next;
            }
            throw new InvalidDataException("LVL release search incomplete: the first 200 releases fill the page limit. Try again later.");
        }

        private static bool CombinedTag(string tag)
        {
            return Regex.IsMatch(tag ?? "", @"\Arelease-\d{4}-\d{2}-\d{2}\.[1-9]\d*\z");
        }

        private static Dictionary<string, object> ObjectField(Dictionary<string, object> obj, string key)
        {
            object value;
            if (!obj.TryGetValue(key, out value) || !(value is Dictionary<string, object>))
                throw new InvalidDataException("Invalid LVL combined release: " + key);
            return (Dictionary<string, object>)value;
        }

        private static long PositiveSize(Dictionary<string, object> obj, string key, long maximum)
        {
            object value;
            if (!obj.TryGetValue(key, out value) || (!(value is int) && !(value is long)) || Convert.ToInt64(value) <= 0 || Convert.ToInt64(value) > maximum)
                throw new InvalidDataException("Invalid LVL combined release: " + key);
            return Convert.ToInt64(value);
        }

        private static void VerifyPinnedBytes(byte[] bytes, long size, string hash)
        {
            if (hash == null) return;
            string actual;
            using (SHA256 digest = SHA256.Create()) actual = BitConverter.ToString(digest.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            if (bytes.LongLength != size || actual != hash) throw new InvalidDataException("LVL manifest download integrity check failed");
        }

        private static string ValidateRecord(Dictionary<string, object> record, string version, bool windows,
            string tag, Dictionary<string, Dictionary<string, object>> attached, HashSet<string> expected)
        {
            string name = Value(record, "name"), url = Value(record, "url"), hash = Value(record, "sha256");
            long size = PositiveSize(record, "size", 2L * 1024 * 1024 * 1024);
            if (name == null || !Regex.IsMatch(name, @"\A[A-Za-z0-9][A-Za-z0-9._-]*\z") || !Regex.IsMatch(hash ?? "", @"\A[a-f0-9]{64}\z"))
                throw new InvalidDataException("Invalid LVL combined asset");
            string prefix = ReleaseAssetsPrefix;
            if (url == null || !url.StartsWith(prefix, StringComparison.Ordinal)) throw new InvalidDataException("Invalid LVL combined asset URL");
            string suffix = url.Substring(prefix.Length);
            int slash = suffix.IndexOf('/');
            string source = slash < 0 ? "" : suffix.Substring(0, slash);
            if ((!CombinedTag(source) && source != (windows ? "v" : "android-v") + version) || !ValidReleaseAssetUrl(url, source, name))
                throw new InvalidDataException("Invalid LVL combined source tag");
            if (source == tag)
            {
                Dictionary<string, object> asset;
                if (!expected.Add(name) || !attached.TryGetValue(name, out asset) || Value(asset, "browser_download_url") != url || PositiveSize(asset, "size", 2L * 1024 * 1024 * 1024) != size)
                    throw new InvalidDataException("LVL combined asset metadata mismatch");
                string digest = Value(asset, "digest");
                if (digest != null && digest != "sha256:" + hash) throw new InvalidDataException("LVL combined asset digest mismatch");
            }
            return source;
        }

        private static Release ReadCombinedRelease(Dictionary<string, object> release, string tag,
            Func<string, byte[]> readManifest, Action<int> pause)
        {
            object entries;
            if (!release.TryGetValue("assets", out entries) || !(entries is object[])) throw new InvalidDataException("Invalid LVL combined assets");
            Dictionary<string, Dictionary<string, object>> attached = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            foreach (object entry in (object[])entries)
            {
                Dictionary<string, object> asset = entry as Dictionary<string, object>;
                string name = asset == null ? null : Value(asset, "name");
                if (name == null || attached.ContainsKey(name)) throw new InvalidDataException("Invalid LVL combined assets");
                attached.Add(name, asset);
            }
            Dictionary<string, object> manifestAsset;
            if (!attached.TryGetValue("LVL-release.json", out manifestAsset) || !ValidReleaseAssetUrl(Value(manifestAsset, "browser_download_url"), tag, "LVL-release.json"))
                throw new InvalidDataException("LVL combined release manifest missing");
            long manifestSize = PositiveSize(manifestAsset, "size", 65536);
            byte[] bytes = ReadReleaseFeed(delegate { return readManifest(Value(manifestAsset, "browser_download_url")); }, pause);
            if (bytes.LongLength != manifestSize) throw new InvalidDataException("Invalid LVL combined manifest size");
            string manifestDigest = Value(manifestAsset, "digest");
            if (manifestDigest != null)
            {
                if (!Regex.IsMatch(manifestDigest, @"\Asha256:[a-f0-9]{64}\z")) throw new InvalidDataException("Invalid LVL manifest digest");
                VerifyPinnedBytes(bytes, manifestSize, manifestDigest.Substring(7));
            }
            Dictionary<string, object> manifest;
            try { manifest = new JavaScriptSerializer().DeserializeObject(Encoding.UTF8.GetString(bytes)) as Dictionary<string, object>; }
            catch (Exception issue) { throw new InvalidDataException("Invalid LVL combined manifest", issue); }
            object schema;
            if (manifest == null || !manifest.TryGetValue("schemaVersion", out schema) || !(schema is int) || (int)schema != 1 || Value(manifest, "tag") != tag)
                throw new InvalidDataException("Invalid LVL combined manifest schema");
            Dictionary<string, object> platforms = ObjectField(manifest, "platforms");
            HashSet<string> expected = new HashSet<string>(StringComparer.Ordinal); expected.Add("LVL-release.json");
            Release result = null;
            foreach (string platform in new[] { "windows", "android" })
            {
                if (!platforms.ContainsKey(platform)) continue;
                Dictionary<string, object> info = ObjectField(platforms, platform);
                bool windows = platform == "windows";
                string version = Value(info, "version");
                if (!Regex.IsMatch(version ?? "", @"\A(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\z") || CompareVersions(version, version) != 0)
                    throw new InvalidDataException("Invalid LVL platform version");
                if (!windows) foreach (string part in version.Split('.')) if (int.Parse(part) > 9999) throw new InvalidDataException("Invalid Android version");
                List<Dictionary<string, object>> records = new List<Dictionary<string, object>>();
                Dictionary<string, object> checksum = ObjectField(info, "checksums");
                PositiveSize(checksum, "size", 65536);
                records.Add(checksum);
                if (windows)
                {
                    string kind = Value(info, "kind");
                    Dictionary<string, object> payload = ObjectField(info, "asset");
                    string name = Value(payload, "name");
                    if ((kind != "patch" && kind != "installer") || name != (kind == "patch" ? "LVL-update-v" + version + ".zip" : "LVL-Setup.exe") || (Value(checksum, "name") != name + ".sha256" && Value(checksum, "name") != "SHA256SUMS"))
                        throw new InvalidDataException("Invalid Windows release assets");
                    records.Add(payload);
                    result = new Release { Version = version, IsPatch = kind == "patch", SetupName = name, SetupUrl = Value(payload, "url"), ChecksumUrl = Value(checksum, "url"), PayloadHash = Value(payload, "sha256"), ChecksumHash = Value(checksum, "sha256"), PayloadSize = PositiveSize(payload, "size", 2L * 1024 * 1024 * 1024), ChecksumSize = PositiveSize(checksum, "size", 65536) };
                }
                else
                {
                    if (PositiveSize(info, "versionCode", int.MaxValue) < 205) throw new InvalidDataException("Invalid Android version code");
                    Dictionary<string, object> apks = ObjectField(info, "apks");
                    if (apks.Count != 2 || Value(checksum, "name") != "SHA256SUMS") throw new InvalidDataException("Invalid Android assets");
                    foreach (string abi in new[] { "arm64", "x86_64" })
                    {
                        Dictionary<string, object> apk = ObjectField(apks, abi);
                        if (Value(apk, "name") != "LVL-" + version + "-" + abi + ".apk") throw new InvalidDataException("Invalid Android APK name");
                        PositiveSize(apk, "size", 400L * 1024 * 1024);
                        records.Add(apk);
                    }
                    Dictionary<string, object> notice = ObjectField(info, "notice");
                    if (Value(notice, "name") != "LVL-Android-RELEASE-NOTICE.txt") throw new InvalidDataException("Invalid Android notice");
                    PositiveSize(notice, "size", 65536);
                    records.Add(notice);
                }
                string source = null;
                foreach (Dictionary<string, object> record in records)
                {
                    string found = ValidateRecord(record, version, windows, tag, attached, expected);
                    if (source != null && source != found) throw new InvalidDataException("Mixed LVL platform source tags");
                    source = found;
                }
            }
            if (expected.Count != attached.Count) throw new InvalidDataException("Unexpected LVL combined release assets");
            return result;
        }

        private static bool ValidReleaseAssetUrl(string url, string tag, string name)
        {
            return ValidAssetUrl(url) &&
                string.Equals(url, ReleaseAssetsPrefix + tag + "/" + name, StringComparison.Ordinal);
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
            if (!ValidReleaseFeedUrl(url) && !ValidAssetUrl(url))
                throw new InvalidOperationException("Invalid LVL update URL");
            // .NET Framework can cache an HTTPS service point's TLS settings at
            // WebRequest.Create. Opt in to TLS 1.2 before creating that request.
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            // Follow only canonical, locally constructed release API pages.
            // GitHub asset checksum downloads still use their normal CDN redirect.
            request.AllowAutoRedirect = !ValidReleaseFeedUrl(url);
            request.UserAgent = "LVL-Windows-Launcher/0.1";
            request.Accept = "application/vnd.github+json, */*";
            request.Timeout = 12000;
            request.ReadWriteTimeout = 12000;
            request.AutomaticDecompression = DecompressionMethods.Deflate | DecompressionMethods.GZip;
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
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
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
                    if (total > 2L * 1024 * 1024 * 1024)
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

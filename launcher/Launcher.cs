// LVL Windows tray launcher (C# 5 / .NET Framework 4.5+).
// It starts the app's local server (node server.js) without a console window, opens the app in
// its own window (app mode of your default Chromium browser, so its extensions and sign-ins work,
// else Edge), and stops the server cleanly on Quit by closing its stdin (server.js listens).
// A second launcher passes its request to the first one: open, --quit or --restart.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("LVL")]
[assembly: AssemblyProduct("LVL")]
[assembly: AssemblyDescription("Starts LVL and opens its local media player")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

namespace LanguageVideoLearner
{
    internal sealed class Options
    {
        public bool Background;
        public bool Quit;
        public bool Restart;
        public bool WhichBrowser;
        public int Port = 4273;

        public static Options Parse(string[] args)
        {
            Options options = new Options();
            for (int index = 0; index < args.Length; index++)
            {
                string arg = args[index].ToLowerInvariant();
                if (arg == "--background") options.Background = true;
                else if (arg == "--quit") options.Quit = true;
                else if (arg == "--restart") options.Restart = true;
                else if (arg == "--which-browser") options.WhichBrowser = true;
                else if (arg == "--port" && index + 1 < args.Length)
                {
                    int port;
                    if (int.TryParse(args[index + 1], out port) && port > 1024 && port < 65536) options.Port = port;
                    index++;
                }
            }
            return options;
        }
    }

    internal static class Program
    {
        public const string Title = "LVL";

        [STAThread]
        private static int Main(string[] args)
        {
            Options options = Options.Parse(args);
            // A NEW app identity: never send a Quit or Open signal to the private
            // Alpha v0.2 launcher, even though both apps use port 4273.
            // Keep this identity stable across future public LVL updates.
            string prefix = "Local\\LVL-Public-" + options.Port;
            string root = FindRoot();
            if (root == null)
            {
                MessageBox.Show("Couldn't find LVL next to this launcher (server.js missing). Reinstall LVL Setup.", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 1;
            }
            bool installed = File.Exists(Path.Combine(root, "installed-app.json"));
            // Never honor an inherited private Alpha v0.2 data-root override
            // for the public installed application. Fresh public LVL data is
            // always isolated from the old project's user profile.
            string dataRoot = installed
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LVL", "data")
                : Environment.GetEnvironmentVariable("LANGUAGE_VIDEO_LEARNER_DATA_ROOT");
            if (string.IsNullOrEmpty(dataRoot)) dataRoot = Path.Combine(root, "data");
            Log log = new Log(Path.Combine(dataRoot, "logs"));
            string url = "http://127.0.0.1:" + options.Port + "/";
            if (options.WhichBrowser)
            {
                BrowserChoice browser = Browsers.AppCapable();
                log.Write("launcher", browser != null ? "Would open " + url + " in " + browser.Name + " (" + browser.Path + ") as an app window" : "Would open " + url + " in a browser tab");
                return 0;
            }
            bool createdNew;
            using (Mutex mutex = new Mutex(true, prefix, out createdNew))
            {
                if (!createdNew)
                {
                    // Another launcher runs the app: pass the request on to it.
                    string signal = options.Quit ? "quit" : options.Restart ? "restart" : options.Background ? "" : "open";
                    if (signal.Length > 0 && !Signals.Send(prefix, signal)) log.Write("launcher", "The running launcher didn't answer (" + signal + ")");
                    return 0;
                }
                if (options.Quit || options.Restart) return 0;
                string node = FindNode();
                if (node == null)
                {
                    MessageBox.Show("LVL requires Node.js 22 or newer. Reinstall LVL Setup if the bundled runtime is missing.", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return 1;
                }
                if (!Directory.Exists(Path.Combine(root, "node_modules")))
                {
                    bool installedCopy = File.Exists(Path.Combine(root, "installed-app.json"));
                    string message = installedCopy
                        ? "This installed copy is incomplete because its packaged dependencies are missing. Reinstall the app with the latest setup file."
                        : "The app's packages aren't installed yet. Open a terminal in " + root + " and run: npm install";
                    MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return 1;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (LauncherContext context = new LauncherContext(options, prefix, root, dataRoot, node, url, log))
                {
                    Application.Run(context);
                }
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        // The app folder: this launcher's folder or one above it, the one with server.js and package.json.
        private static string FindRoot()
        {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            for (int step = 0; step < 4 && !string.IsNullOrEmpty(folder); step++)
            {
                if (File.Exists(Path.Combine(folder, "server.js")) && File.Exists(Path.Combine(folder, "package.json"))) return folder.TrimEnd('\\');
                DirectoryInfo parent = Directory.GetParent(folder.TrimEnd('\\'));
                folder = parent == null ? null : parent.FullName;
            }
            return null;
        }

        private static string FindNode()
        {
            // Installers bundle Node. Always prefer the trusted executable next
            // to the installed app, rather than global PATH or another project.
            string root = FindRoot();
            if (!string.IsNullOrEmpty(root))
            {
                string bundled = Path.Combine(root, "runtime", "node.exe");
                if (File.Exists(bundled)) return bundled;
                if (File.Exists(Path.Combine(root, "installed-app.json"))) return null;
            }
            string chosen = Environment.GetEnvironmentVariable("LANGUAGE_VIDEO_LEARNER_NODE");
            if (!string.IsNullOrEmpty(chosen) && File.Exists(chosen)) return chosen;
            string paths = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string entry in paths.Split(';'))
            {
                try
                {
                    string folder = entry.Trim().Trim('"');
                    if (folder.Length == 0) continue;
                    string candidate = Path.Combine(folder, "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch (ArgumentException) { }
            }
            string[] folders =
            {
                Environment.GetEnvironmentVariable("ProgramW6432"),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"),
            };
            foreach (string folder in folders)
            {
                if (string.IsNullOrEmpty(folder)) continue;
                string candidate = Path.Combine(Path.Combine(folder, "nodejs"), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }
    }

    /** A plain text log in the data folder (data\logs\launcher.log), the app's own output included. */
    internal sealed class Log
    {
        private const long MaxBytes = 4L * 1024 * 1024;
        private readonly object gate = new object();
        private readonly string folder;
        private readonly string path;
        private int writes;

        public Log(string folder)
        {
            this.folder = folder;
            path = Path.Combine(folder, "launcher.log");
            try { Directory.CreateDirectory(folder); } catch (Exception) { }
            Rotate();
        }

        public string FilePath { get { return path; } }

        public void Write(string source, string message)
        {
            lock (gate)
            {
                try
                {
                    if (++writes % 500 == 0) Rotate();
                    File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + source.PadRight(8) + " " + message + Environment.NewLine, Encoding.UTF8);
                }
                catch (Exception) { }
            }
        }

        // One older log is kept (launcher.old.log).
        private void Rotate()
        {
            try
            {
                if (!File.Exists(path) || new FileInfo(path).Length < MaxBytes) return;
                string old = Path.Combine(folder, "launcher.old.log");
                if (File.Exists(old)) File.Delete(old);
                File.Move(path, old);
            }
            catch (Exception) { }
        }
    }

    /** Requests from a second launcher (open, quit, restart), as named events per port. */
    internal static class Signals
    {
        public static readonly string[] Names = { "open", "quit", "restart" };

        public static bool Send(string prefix, string name)
        {
            for (int attempt = 0; attempt < 40; attempt++)
            {
                EventWaitHandle handle;
                if (EventWaitHandle.TryOpenExisting(prefix + "-" + name, out handle))
                {
                    using (handle) handle.Set();
                    return true;
                }
                Thread.Sleep(100);
            }
            return false;
        }
    }

    internal sealed class BrowserChoice
    {
        public string Name;
        public string Path;
    }

    /** The browser for the app window: your default one if it's Chromium-based (app mode), else Edge or Chrome. */
    internal static class Browsers
    {
        private static readonly string[] Chromium = { "brave.exe", "chrome.exe", "msedge.exe", "vivaldi.exe", "chromium.exe", "thorium.exe" };

        public static BrowserChoice AppCapable()
        {
            BrowserChoice chosen = FromPath(Environment.GetEnvironmentVariable("LANGUAGE_VIDEO_LEARNER_BROWSER"));
            if (chosen != null) return chosen;
            chosen = FromPath(ReadValue(Registry.CurrentUser, "Software\\LVL", "Browser"));
            if (chosen != null) return chosen;
            string progId = ReadValue(Registry.CurrentUser, "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice", "ProgId");
            if (!string.IsNullOrEmpty(progId))
            {
                chosen = FromPath(ExeFromCommand(ReadValue(Registry.ClassesRoot, progId + "\\shell\\open\\command", "")));
                if (chosen != null) return chosen;
            }
            foreach (string exe in new[] { "msedge.exe", "chrome.exe", "brave.exe" })
            {
                foreach (RegistryKey hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
                {
                    chosen = FromPath(ReadValue(hive, "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exe, ""));
                    if (chosen != null) return chosen;
                }
            }
            return null;
        }

        private static BrowserChoice FromPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            path = path.Trim().Trim('"');
            try
            {
                if (!File.Exists(path)) return null;
                string name = System.IO.Path.GetFileName(path).ToLowerInvariant();
                if (Array.IndexOf(Chromium, name) < 0) return null;
                BrowserChoice choice = new BrowserChoice();
                choice.Name = name;
                choice.Path = path;
                return choice;
            }
            catch (ArgumentException) { return null; }
        }

        // "C:\...\brave.exe" --single-argument %1  →  C:\...\brave.exe
        private static string ExeFromCommand(string command)
        {
            if (string.IsNullOrEmpty(command)) return null;
            command = command.Trim();
            if (command.StartsWith("\""))
            {
                int end = command.IndexOf('"', 1);
                return end > 1 ? command.Substring(1, end - 1) : null;
            }
            int exe = command.ToLowerInvariant().IndexOf(".exe");
            return exe > 0 ? command.Substring(0, exe + 4) : null;
        }

        public static string ReadValue(RegistryKey hive, string keyPath, string name)
        {
            try
            {
                using (RegistryKey key = hive.OpenSubKey(keyPath))
                {
                    object value = key == null ? null : key.GetValue(name);
                    return value == null ? null : value.ToString();
                }
            }
            catch (Exception) { return null; }
        }
    }

    /** The tray icon, its menu and the app's server process. */
    internal sealed class LauncherContext : ApplicationContext
    {
        private const string RunKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        private const string SettingsKey = "Software\\LVL";
        private readonly Options options;
        private readonly string prefix;
        private readonly string root;
        private readonly string dataRoot;
        private readonly string node;
        private readonly string url;
        private readonly Log log;
        private readonly object gate = new object();
        private readonly NotifyIcon tray;
        private readonly Control invoker;
        private readonly ToolStripMenuItem statusItem;
        private readonly ToolStripMenuItem restartItem;
        private readonly ToolStripMenuItem startupItem;
        private readonly ToolStripMenuItem quitItem;
        private readonly PackagedUpdater updater;
        private readonly string updateBridge;
        private readonly ManualResetEvent stopListening = new ManualResetEvent(false);
        private Process server;
        private volatile bool ownServer;
        private volatile bool quitting;
        private volatile bool busy;
        private volatile bool openWhenReady;
        private int crashes;
        private DateTime firstCrashAt = DateTime.MinValue;
        private DateTime lastOpenAt = DateTime.MinValue;

        public LauncherContext(Options options, string prefix, string root, string dataRoot, string node, string url, Log log)
        {
            this.options = options;
            this.prefix = prefix;
            this.root = root;
            this.dataRoot = dataRoot;
            this.node = node;
            this.url = url;
            this.log = log;
            // Work done on other threads reaches the menu and the tray icon through this control.
            invoker = new Control();
            IntPtr handle = invoker.Handle;
            if (handle == IntPtr.Zero) throw new InvalidOperationException("No window handle");

            statusItem = new ToolStripMenuItem("Starting…");
            statusItem.Enabled = false;
            ToolStripMenuItem openItem = new ToolStripMenuItem("Open " + Program.Title, null, delegate { Open(false); });
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            ToolStripMenuItem tabItem = new ToolStripMenuItem("Open in a browser tab", null, delegate { Open(true); });
            restartItem = new ToolStripMenuItem("Restart the app", null, delegate { Restart(); });
            ToolStripMenuItem dataItem = new ToolStripMenuItem("Open the data folder", null, delegate { OpenFolder(dataRoot); });
            ToolStripMenuItem logItem = new ToolStripMenuItem("Show the log", null, delegate { OpenLog(); });
            startupItem = new ToolStripMenuItem("Start with Windows", null, delegate { ToggleStartup(); });
            quitItem = new ToolStripMenuItem("Quit", null, delegate { Quit(); });
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.AddRange(new ToolStripItem[] { statusItem, new ToolStripSeparator(), openItem, tabItem, new ToolStripSeparator(), restartItem, dataItem, logItem });
            if (PackagedUpdater.IsInstalled(root))
            {
                updater = new PackagedUpdater(root, log, invoker, Notify);
                updater.AddTo(menu);
                // The isolated alpha build substitutes AlphaUpdater at compile time.
                // The ordinary packaged launcher has no bridge and is unaffected.
                MethodInfo bridgeMethod = updater.GetType().GetMethod("BeginBridge",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (bridgeMethod != null)
                {
                    try { updateBridge = (string)bridgeMethod.Invoke(updater, null); }
                    catch (Exception error) { log.Write("updater", "Couldn't start update bridge: " + error.Message); }
                }
            }
            menu.Items.AddRange(new ToolStripItem[] { new ToolStripSeparator(), startupItem, new ToolStripSeparator(), quitItem });
            menu.Opening += delegate
            {
                startupItem.Checked = StartsWithWindows();
                restartItem.Enabled = ownServer && !quitting && !busy;
                quitItem.Text = ownServer ? "Quit" : "Close the launcher";
            };

            tray = new NotifyIcon();
            tray.Icon = LoadIcon(root);
            tray.Text = Program.Title;
            tray.ContextMenuStrip = menu;
            tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Open(false); };
            tray.Visible = true;

            SystemEvents.SessionEnding += OnSessionEnding;
            ListenForSignals();
            if (updater != null) updater.CheckOnStartup();
            Begin();
        }

        // ------------------------------------------------------------------ starting

        private void Begin()
        {
            log.Write("launcher", "Launcher started for " + url + " (app folder " + root + ")");
            ThreadPool.QueueUserWorkItem(delegate
            {
                if (IsAppRunning())
                {
                    log.Write("launcher", "The app is already running at " + url);
                    Ui(delegate
                    {
                        SetState("Running (started outside the launcher)");
                        if (!options.Background) OpenWindow(false);
                    });
                    return;
                }
                if (IsPortTaken())
                {
                    Ui(delegate { Fail("Port " + options.Port + " is used by another program, so the app can't start. Close that program and start the app again."); });
                    return;
                }
                StartAndWait(!options.Background);
            });
        }

        private void StartServer()
        {
            ProcessStartInfo info = new ProcessStartInfo(node, "server.js");
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            info.EnvironmentVariables["PORT"] = options.Port.ToString();
            info.EnvironmentVariables["LANGUAGE_VIDEO_LEARNER_LAUNCHER"] = "1";
            info.EnvironmentVariables["LANGUAGE_VIDEO_LEARNER_DATA_ROOT"] = dataRoot;
            if (!string.IsNullOrEmpty(updateBridge))
                info.EnvironmentVariables["LANGUAGE_VIDEO_LEARNER_UPDATE_BRIDGE"] = updateBridge;
            info.EnvironmentVariables["NO_COLOR"] = "1";
            Process process = new Process();
            process.StartInfo = info;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) log.Write("app", e.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) log.Write("app", e.Data); };
            process.Exited += OnServerExited;
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            server = process;
            ownServer = true;
            log.Write("launcher", "Started the app (process " + process.Id + ", " + node + ")");
        }

        /** Starts the app unless it's starting already, then waits until it answers. */
        private void StartAndWait(bool open)
        {
            Process started;
            lock (gate)
            {
                if (open) openWhenReady = true;
                if (server != null && !server.HasExited) return;
                try
                {
                    StartServer();
                }
                catch (Exception error)
                {
                    log.Write("launcher", "Couldn't start the app: " + error.Message);
                    Ui(delegate { SetState("Stopped"); Notify("Couldn't start the app: " + error.Message); });
                    return;
                }
                started = server;
            }
            Ui(delegate { SetState("Starting…"); });
            Stopwatch watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < 60000)
            {
                if (quitting || started.HasExited || !ReferenceEquals(started, server)) return;
                if (IsAppRunning())
                {
                    log.Write("launcher", "The app is running at " + url);
                    Ui(delegate
                    {
                        SetState("Running at " + url.TrimEnd('/'));
                        if (openWhenReady)
                        {
                            openWhenReady = false;
                            OpenWindow(false);
                        }
                        FirstRunTip();
                    });
                    return;
                }
                Thread.Sleep(300);
            }
            Ui(delegate { Notify("The app is taking long to start. Show the log to see why."); });
        }

        private void OnServerExited(object sender, EventArgs e)
        {
            Process process = sender as Process;
            int code = -1;
            try { code = process.ExitCode; } catch (Exception) { }
            lock (gate)
            {
                // Stopped on purpose (Quit or Restart): nothing to do.
                if (process == null || !ReferenceEquals(process, server)) return;
                server = null;
            }
            log.Write("launcher", "The app stopped by itself (exit code " + code + ")");
            if (quitting) return;
            DateTime now = DateTime.UtcNow;
            if ((now - firstCrashAt).TotalMinutes > 2)
            {
                firstCrashAt = now;
                crashes = 0;
            }
            crashes++;
            if (crashes <= 2)
            {
                Ui(delegate { SetState("Restarting…"); });
                ThreadPool.QueueUserWorkItem(delegate
                {
                    Thread.Sleep(1500);
                    if (!quitting) StartAndWait(false);
                });
                return;
            }
            Ui(delegate
            {
                SetState("Stopped");
                Notify("Language Video Learner stopped. Use Restart the app in this menu, or Show the log to see why.");
            });
        }

        /** Closes the app's stdin so it shuts down cleanly (it deletes its downloads); ends it if it hangs. */
        private void StopServer(int waitMs)
        {
            Process process;
            lock (gate)
            {
                process = server;
                server = null;
            }
            if (process == null) return;
            try
            {
                if (!process.HasExited)
                {
                    try { process.StandardInput.Close(); } catch (Exception) { }
                    if (!process.WaitForExit(waitMs))
                    {
                        log.Write("launcher", "The app didn't stop in time; ending it");
                        EndTree(process.Id);
                        process.WaitForExit(3000);
                    }
                }
                log.Write("launcher", "Stopped the app (exit code " + process.ExitCode + ")");
            }
            catch (Exception error)
            {
                log.Write("launcher", "Stopping the app: " + error.Message);
            }
        }

        // The app and anything it started (video conversions).
        private static void EndTree(int processId)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo("taskkill.exe", "/T /F /PID " + processId);
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                using (Process taskkill = Process.Start(info)) taskkill.WaitForExit(5000);
            }
            catch (Exception) { }
        }

        // ------------------------------------------------------------------ menu actions

        private void Open(bool tab)
        {
            // One click, one window (a double click arrives as two clicks).
            if ((DateTime.UtcNow - lastOpenAt).TotalMilliseconds < 1500) return;
            lastOpenAt = DateTime.UtcNow;
            ThreadPool.QueueUserWorkItem(delegate
            {
                if (IsAppRunning())
                {
                    Ui(delegate { OpenWindow(tab); });
                    return;
                }
                if (quitting) return;
                Process current = server;
                if (current != null && !current.HasExited)
                {
                    openWhenReady = true;
                    return;
                }
                if (IsPortTaken())
                {
                    Ui(delegate { Notify("Port " + options.Port + " is used by another program."); });
                    return;
                }
                StartAndWait(true);
            });
        }

        private void OpenWindow(bool tab)
        {
            BrowserChoice browser = tab ? null : Browsers.AppCapable();
            try
            {
                string isolatedProfile = File.Exists(Path.Combine(root, "installed-app.json"))
                    ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LVL", "browser-profile")
                    : Environment.GetEnvironmentVariable("LANGUAGE_VIDEO_LEARNER_BROWSER_PROFILE_DIR");
                string appArguments = "--app=" + url;
                if (browser != null && !string.IsNullOrWhiteSpace(isolatedProfile))
                {
                    Directory.CreateDirectory(isolatedProfile);
                    appArguments = "--user-data-dir=\"" + isolatedProfile.Replace("\"", "") + "\" " + appArguments;
                }
                // The packaged alpha uses its own Brave profile. A local theme
                // colors Brave's *native window frame*, which CSS/theme-color
                // cannot color in a --app window on Windows 10. Never load it
                // into the user's normal browser profile or another browser.
                string nativeFrameTheme = Environment.GetEnvironmentVariable("LANGUAGE_VIDEO_LEARNER_BROWSER_THEME_DIR");
                if (string.IsNullOrWhiteSpace(nativeFrameTheme) && File.Exists(Path.Combine(root, "installed-app.json")))
                    nativeFrameTheme = Path.Combine(root, "assets", "platform", "alpha-window-theme");
                if (browser != null && browser.Name == "brave.exe" &&
                    !string.IsNullOrWhiteSpace(isolatedProfile) &&
                    !string.IsNullOrWhiteSpace(nativeFrameTheme) &&
                    File.Exists(Path.Combine(nativeFrameTheme, "manifest.json")))
                {
                    appArguments = "--load-extension=\"" + nativeFrameTheme.Replace("\"", "") + "\" " + appArguments;
                }
                ProcessStartInfo info = browser != null ? new ProcessStartInfo(browser.Path, appArguments) : new ProcessStartInfo(url);
                info.UseShellExecute = true;
                Process.Start(info);
                log.Write("launcher", browser != null ? "Opened the app window in " + browser.Name : "Opened the app in a browser tab");
            }
            catch (Exception error)
            {
                log.Write("launcher", "Couldn't open the browser: " + error.Message);
                Notify("Couldn't open the browser. The app is at " + url);
            }
        }

        private void Restart()
        {
            if (busy || quitting) return;
            if (!ownServer)
            {
                Notify("This copy of the app was started outside the launcher, so it can't be restarted from here.");
                return;
            }
            busy = true;
            SetState("Restarting…");
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    StopServer(10000);
                    crashes = 0;
                    StartAndWait(false);
                }
                finally
                {
                    busy = false;
                }
            });
        }

        private void Quit()
        {
            if (quitting) return;
            quitting = true;
            SetState("Stopping…");
            ThreadPool.QueueUserWorkItem(delegate
            {
                StopServer(10000);
                log.Write("launcher", "Launcher closed");
                Ui(delegate { ExitThread(); });
            });
        }

        private void OnSessionEnding(object sender, SessionEndingEventArgs e)
        {
            // Windows is signing out or shutting down: stop the app now, cleanly if it can.
            quitting = true;
            StopServer(5000);
        }

        private void OpenFolder(string folder)
        {
            try
            {
                Directory.CreateDirectory(folder);
                Process.Start("explorer.exe", "\"" + folder + "\"");
            }
            catch (Exception error) { Notify(error.Message); }
        }

        private void OpenLog()
        {
            try { Process.Start("notepad.exe", "\"" + log.FilePath + "\""); }
            catch (Exception error) { Notify(error.Message); }
        }

        private string RunName()
        {
            return "LVL";
        }

        private bool StartsWithWindows()
        {
            return !string.IsNullOrEmpty(Browsers.ReadValue(Registry.CurrentUser, RunKey, RunName()));
        }

        private void ToggleStartup()
        {
            try
            {
                bool on = !StartsWithWindows();
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (on) key.SetValue(RunName(), "\"" + Application.ExecutablePath + "\" --background --port " + options.Port);
                    else key.DeleteValue(RunName(), false);
                }
                Notify(on ? "The app will start with Windows, in the tray." : "The app won't start with Windows.");
            }
            catch (Exception error) { Notify("Couldn't change that: " + error.Message); }
        }

        // ------------------------------------------------------------------ helpers

        private void ListenForSignals()
        {
            EventWaitHandle[] handles = new EventWaitHandle[Signals.Names.Length];
            for (int index = 0; index < handles.Length; index++)
            {
                handles[index] = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-" + Signals.Names[index]);
            }
            WaitHandle[] all = new WaitHandle[handles.Length + 1];
            Array.Copy(handles, all, handles.Length);
            all[handles.Length] = stopListening;
            Thread thread = new Thread(delegate ()
            {
                try
                {
                    while (true)
                    {
                        int index = WaitHandle.WaitAny(all);
                        if (index >= handles.Length) return;
                        string name = Signals.Names[index];
                        Ui(delegate
                        {
                            if (name == "open") Open(false);
                            else if (name == "quit") Quit();
                            else Restart();
                        });
                    }
                }
                catch (Exception) { }
                finally
                {
                    foreach (EventWaitHandle handle in handles) handle.Close();
                }
            });
            thread.IsBackground = true;
            thread.Name = "Launcher requests";
            thread.Start();
        }

        private bool IsAppRunning()
        {
            // Nothing listening: answer at once (Windows takes about 2 s to refuse a connection).
            if (!IsListening(400)) return false;
            try
            {
                string response = Get(url + "api/health", 1500);
                // Never adopt a private Alpha 0.2.x server sharing port 4273.
                // The public installation has an explicit identity, stable
                // across its own 0.1, 0.2 and later public version families.
                bool publicInstall = File.Exists(Path.Combine(root, "installed-app.json"));
                return response.Contains("\"app\":\"language-video-learner\"") &&
                    (publicInstall ? response.Contains("\"appId\":\"lvl-public\"")
                        : response.Contains("\"version\":"));
            }
            catch (Exception) { }
            return false;
        }

        private bool IsPortTaken()
        {
            return IsListening(800);
        }

        private bool IsListening(int timeoutMs)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult attempt = client.BeginConnect("127.0.0.1", options.Port, null, null);
                    if (!attempt.AsyncWaitHandle.WaitOne(timeoutMs)) return false;
                    client.EndConnect(attempt);
                    return true;
                }
            }
            catch (Exception) { return false; }
        }

        private static string Get(string address, int timeoutMs)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(address);
            request.Proxy = null;
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            request.KeepAlive = false;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        private void Ui(MethodInvoker action)
        {
            try
            {
                if (invoker.IsDisposed) return;
                if (invoker.InvokeRequired) invoker.BeginInvoke(action);
                else action();
            }
            catch (InvalidOperationException) { }
        }

        private void SetState(string text)
        {
            statusItem.Text = text;
            string tip = Program.Title + ": " + text;
            tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
        }

        private void Notify(string text)
        {
            log.Write("launcher", text);
            if (tray.Visible) tray.ShowBalloonTip(6000, Program.Title, text, ToolTipIcon.Info);
        }

        private void FirstRunTip()
        {
            if (Browsers.ReadValue(Registry.CurrentUser, SettingsKey, "TrayTipShown") == "1") return;
            try
            {
                using (RegistryKey settings = Registry.CurrentUser.CreateSubKey(SettingsKey)) settings.SetValue("TrayTipShown", "1");
            }
            catch (Exception) { }
            Notify("LVL runs from this icon. Click it to open the app; right-click to quit.");
        }

        private void Fail(string message)
        {
            log.Write("launcher", message);
            quitting = true;
            tray.Visible = false;
            MessageBox.Show(message, Program.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            ExitThread();
        }

        private static Icon LoadIcon(string root)
        {
            try
            {
                string file = Path.Combine(root, "assets", "platform", "favicon.ico");
                if (File.Exists(file)) return new Icon(file, SystemInformation.SmallIconSize);
            }
            catch (Exception) { }
            try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch (Exception) { return SystemIcons.Application; }
        }

        protected override void ExitThreadCore()
        {
            stopListening.Set();
            EndUpdateBridge();
            tray.Visible = false;
            base.ExitThreadCore();
        }

        private void EndUpdateBridge()
        {
            if (updater == null) return;
            MethodInfo bridgeMethod = updater.GetType().GetMethod("EndBridge",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (bridgeMethod != null)
            {
                try { bridgeMethod.Invoke(updater, null); }
                catch (Exception error) { log.Write("updater", "Couldn't stop update bridge: " + error.Message); }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                SystemEvents.SessionEnding -= OnSessionEnding;
                stopListening.Set();
                EndUpdateBridge();
                tray.Visible = false;
                tray.Dispose();
                invoker.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}

// LVL's pop-up player: a borderless, always-on-top window with a WebView2 control that
// shows LVL's own player page (/watch?popup=...). LVL's server starts it and talks to it
// over stdin/stdout, one JSON object per line:
//   in:  {"op":"show","url":"http://127.0.0.1:4273/watch?popup=...","bounds":{"x":0,"y":0,"width":480,"height":270}}
//        {"op":"hide"}    {"op":"quit"}
//   out: {"event":"ready"}  {"event":"shown"}  {"event":"hidden","reason":"user|page|server"}
//        {"event":"bounds","x":0,"y":0,"width":480,"height":270}  {"event":"error","message":"..."}
// The window has no frame at all: the page asks for a move (drag on the video) or an edge
// resize with chrome.webview.postMessage, and Windows does the rest. The window keeps the
// video's shape while it is resized. It ends when its input closes (LVL stopped).
// Built with the .NET Framework C# 5 compiler (scripts/build-popup.mjs, installer/build.ps1).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Lvl.Popup
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string profile = null;
            for (int i = 0; i + 1 < args.Length; i++)
                if (args[i] == "--profile") profile = args[i + 1];
            if (string.IsNullOrEmpty(profile)) return 2;
            Native.UsePerMonitorDpi();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            PopupWindow window = new PopupWindow(profile);
            window.Start();
            Application.Run(new ApplicationContext());
            return 0;
        }
    }

    internal sealed class PopupWindow : Form
    {
        // A page that hasn't said it's ready this long after showing gets the window hidden:
        // without a frame, a page that never loaded would leave no way to close it.
        private const int PAGE_READY_MS = 20000;

        private readonly string profile;
        private readonly WebView2 view = new WebView2();
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly object writeGate = new object();
        private readonly StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        private readonly System.Windows.Forms.Timer dragTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer readyTimer = new System.Windows.Forms.Timer();
        private bool ready;
        private bool pageReady;
        private Dictionary<string, object> pendingShow;
        private string allowedOrigin = "";
        private double aspect = 16.0 / 9.0;
        private int dragEdge;
        private Point dragCursor;
        private Rectangle dragBounds;
        private DateTime dragStarted;

        public PopupWindow(string profile)
        {
            this.profile = profile;
            Text = "LVL";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.Black;
            MinimumSize = new Size(Px(240), Px(135));
            view.Dock = DockStyle.Fill;
            view.DefaultBackgroundColor = Color.Black;
            Controls.Add(view);
            dragTimer.Interval = 15;
            dragTimer.Tick += OnDragTick;
            readyTimer.Interval = PAGE_READY_MS;
            readyTimer.Tick += delegate
            {
                readyTimer.Stop();
                if (Visible && !pageReady) HideWindow("page");
            };
        }

        // An automatic pop-out (leaving Watch) must not take the keyboard from the main window.
        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        public void Start()
        {
            // Made hidden: the first pop-out then only loads the page.
            CreateHandle();
            view.CreateControl();
            Native.RoundCorners(Handle);
            Thread reader = new Thread(ReadCommands);
            reader.IsBackground = true;
            reader.Start();
            BeginInvoke(new MethodInvoker(delegate { InitializeWebView(); }));
        }

        private async void InitializeWebView()
        {
            try
            {
                // The video continues from the main window, so it starts without a click.
                CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile, options);
                await view.EnsureCoreWebView2Async(environment);
                CoreWebView2Settings settings = view.CoreWebView2.Settings;
                bool devTools = Environment.GetEnvironmentVariable("LVL_POPUP_DEVTOOLS") == "1";
                settings.AreDefaultContextMenusEnabled = devTools;
                settings.AreDevToolsEnabled = devTools;
                settings.IsStatusBarEnabled = false;
                settings.IsZoomControlEnabled = false;
                settings.IsPinchZoomEnabled = false;
                settings.IsSwipeNavigationEnabled = false;
                settings.AreBrowserAcceleratorKeysEnabled = devTools;
                view.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
                view.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
                {
                    // Only LVL's own page (and the blank page used to stop playback).
                    if (e.Uri != "about:blank" && (allowedOrigin.Length == 0 || !e.Uri.StartsWith(allowedOrigin + "/", StringComparison.Ordinal))) e.Cancel = true;
                };
                view.CoreWebView2.WebMessageReceived += OnPageMessage;
                view.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
                {
                    // LVL's page didn't load (LVL stopped?): a frameless window can't stay up empty.
                    if (!e.IsSuccess && Visible && view.CoreWebView2.Source != "about:blank") HideWindow("page");
                };
                ready = true;
                // Protocol 1: the commands and events above. A newer LVL can refuse an older program.
                Send("ready", new Dictionary<string, object> { { "protocol", 1 } });
                if (pendingShow != null)
                {
                    Dictionary<string, object> show = pendingShow;
                    pendingShow = null;
                    ShowPage(show);
                }
            }
            catch (Exception error)
            {
                Send("error", new Dictionary<string, object> { { "message", "WebView2: " + error.Message } });
            }
        }

        private void ReadCommands()
        {
            StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            while (true)
            {
                string line;
                try { line = input.ReadLine(); }
                catch (IOException) { line = null; }
                if (line == null) break;
                Dictionary<string, object> command;
                try { command = json.Deserialize<Dictionary<string, object>>(line); }
                catch (ArgumentException) { continue; }
                catch (InvalidOperationException) { continue; }
                if (command == null) continue;
                try { BeginInvoke(new MethodInvoker(delegate { Execute(command); })); }
                catch (InvalidOperationException) { break; }
            }
            // LVL closed our input: it's done with the pop-up.
            try { BeginInvoke(new MethodInvoker(delegate { Quit(); })); }
            catch (InvalidOperationException) { Environment.Exit(0); }
        }

        private void Execute(Dictionary<string, object> command)
        {
            string op = Str(command, "op");
            if (op == "show")
            {
                if (ready) ShowPage(command);
                else pendingShow = command;
            }
            else if (op == "hide") HideWindow("server");
            else if (op == "quit") Quit();
        }

        private void ShowPage(Dictionary<string, object> command)
        {
            Uri url;
            if (!Uri.TryCreate(Str(command, "url"), UriKind.Absolute, out url) || url.Scheme != "http"
                || (url.Host != "127.0.0.1" && url.Host != "localhost"))
            {
                Send("error", new Dictionary<string, object> { { "message", "The pop-up only opens LVL's own page" } });
                return;
            }
            allowedOrigin = url.GetLeftPart(UriPartial.Authority);
            Bounds = PlaceWindow(command.ContainsKey("bounds") ? command["bounds"] as Dictionary<string, object> : null);
            pageReady = false;
            view.CoreWebView2.Navigate(url.AbsoluteUri);
            Show();
            TopMost = true;
            readyTimer.Stop();
            readyTimer.Start();
            Send("shown", null);
        }

        private Rectangle PlaceWindow(Dictionary<string, object> saved)
        {
            // Automated checks place the window off-screen, so it never covers the user's screen.
            if (Environment.GetEnvironmentVariable("LVL_POPUP_TEST") == "1") return new Rectangle(-10000, -10000, Px(480), Px(270));
            if (saved != null)
            {
                Rectangle wanted = new Rectangle(Number(saved, "x"), Number(saved, "y"), Number(saved, "width"), Number(saved, "height"));
                if (wanted.Width >= MinimumSize.Width && wanted.Height >= MinimumSize.Height)
                    foreach (Screen screen in Screen.AllScreens)
                        if (screen.WorkingArea.IntersectsWith(wanted)) return wanted;
            }
            // Bottom right of the screen the pointer is on, like the browser's pop-up, clear of
            // the taskbar even when it hides itself (the work area then reaches the screen edge).
            Screen target = Screen.FromPoint(Cursor.Position);
            Rectangle area = target.WorkingArea;
            int width = Px(480);
            int height = (int)Math.Round(width / aspect);
            int margin = Px(24);
            int bottom = area.Bottom == target.Bounds.Bottom ? area.Bottom - Px(48) : area.Bottom;
            return new Rectangle(area.Right - width - margin, bottom - height - margin, width, height);
        }

        private void OnPageMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (allowedOrigin.Length == 0 || !e.Source.StartsWith(allowedOrigin + "/", StringComparison.Ordinal)) return;
            Dictionary<string, object> message;
            try { message = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); }
            catch (ArgumentException) { return; }
            catch (InvalidOperationException) { return; }
            if (message == null) return;
            string type = Str(message, "type");
            if (type == "ready") pageReady = true;
            else if (type == "move") BeginDrag(0);
            else if (type == "resize")
            {
                int edge = EdgeCode(Str(message, "edge"));
                if (edge != 0) BeginDrag(edge);
            }
            else if (type == "aspect")
            {
                double ratio = Convert.ToDouble(message.ContainsKey("ratio") ? message["ratio"] : 0);
                if (ratio > 0.3 && ratio < 4)
                {
                    aspect = ratio;
                    // Fit the current width to the video's shape.
                    Size = new Size(Width, (int)Math.Round(Width / aspect));
                }
            }
            else if (type == "hide") HideWindow("page");
        }

        // The window follows the pointer while the primary button is physically held, and stops
        // the moment it is released (checked every frame), so it can never stay stuck to it.
        private void BeginDrag(int edge)
        {
            if (!Visible || !Native.PrimaryButtonDown()) return;
            dragEdge = edge;
            dragCursor = Cursor.Position;
            dragBounds = Bounds;
            dragStarted = DateTime.UtcNow;
            dragTimer.Start();
        }

        private void OnDragTick(object sender, EventArgs e)
        {
            if (!Visible || !Native.PrimaryButtonDown() || (DateTime.UtcNow - dragStarted).TotalSeconds > 60)
            {
                dragTimer.Stop();
                SendBounds();
                return;
            }
            Point now = Cursor.Position;
            int dx = now.X - dragCursor.X;
            int dy = now.Y - dragCursor.Y;
            if (dragEdge == 0) Location = new Point(dragBounds.X + dx, dragBounds.Y + dy);
            else Bounds = Resized(dragBounds, dragEdge, dx, dy);
        }

        // Resizing keeps the video's shape and the opposite edges in place.
        private Rectangle Resized(Rectangle start, int edge, int dx, int dy)
        {
            bool left = edge == 10 || edge == 13 || edge == 16;
            bool right = edge == 11 || edge == 14 || edge == 17;
            bool top = edge == 12 || edge == 13 || edge == 14;
            bool bottom = edge == 15 || edge == 16 || edge == 17;
            int width = left ? start.Width - dx : right ? start.Width + dx
                : (int)Math.Round((start.Height + (bottom ? dy : -dy)) * aspect);
            int widest = Screen.FromRectangle(start).WorkingArea.Width;
            width = Math.Max(MinimumSize.Width, Math.Min(widest, width));
            int height = Math.Max(MinimumSize.Height, (int)Math.Round(width / aspect));
            int x = left ? start.Right - width : start.X;
            int y = top ? start.Bottom - height : start.Y;
            return new Rectangle(x, y, width, height);
        }

        private static int EdgeCode(string edge)
        {
            switch (edge)
            {
                case "w": return 10;
                case "e": return 11;
                case "n": return 12;
                case "nw": return 13;
                case "ne": return 14;
                case "s": return 15;
                case "sw": return 16;
                case "se": return 17;
                default: return 0;
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Alt+F4 or the window menu hides the pop-up; LVL decides when it ends.
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideWindow("user");
                return;
            }
            base.OnFormClosing(e);
        }

        private void HideWindow(string reason)
        {
            dragTimer.Stop();
            readyTimer.Stop();
            if (!Visible && !Native.IsWindowVisible(Handle)) return;
            SendBounds();
            Hide();
            // A frameless always-on-top window must never stay on screen after a close.
            if (Native.IsWindowVisible(Handle)) Native.ForceHide(Handle);
            if (Native.IsWindowVisible(Handle))
            {
                // Still showing: end the program, which takes the window with it (LVL starts it again).
                Send("error", new Dictionary<string, object> { { "message", "The pop-up window didn't close; it was stopped" } });
                Send("hidden", new Dictionary<string, object> { { "reason", reason } });
                Environment.Exit(3);
                return;
            }
            // Stops the video and its sound.
            if (ready) view.CoreWebView2.Navigate("about:blank");
            Send("hidden", new Dictionary<string, object> { { "reason", reason } });
        }

        private void SendBounds()
        {
            if (!Visible || WindowState != FormWindowState.Normal) return;
            Send("bounds", new Dictionary<string, object> { { "x", Left }, { "y", Top }, { "width", Width }, { "height", Height } });
        }

        private void Quit()
        {
            try { view.Dispose(); } catch (Exception) { }
            Application.Exit();
        }

        private void Send(string name, Dictionary<string, object> fields)
        {
            Dictionary<string, object> message = fields ?? new Dictionary<string, object>();
            message["event"] = name;
            lock (writeGate)
            {
                try
                {
                    output.WriteLine(json.Serialize(message));
                    output.Flush();
                }
                catch (IOException) { }
            }
        }

        private int Px(int pixels)
        {
            using (Graphics screen = Graphics.FromHwnd(IntPtr.Zero)) return (int)Math.Round(pixels * screen.DpiX / 96f);
        }

        private static string Str(Dictionary<string, object> values, string key)
        {
            object value;
            return values.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
        }

        private static int Number(Dictionary<string, object> values, string key)
        {
            object value;
            if (!values.TryGetValue(key, out value) || value == null) return 0;
            try { return Convert.ToInt32(value); }
            catch (FormatException) { return 0; }
            catch (InvalidCastException) { return 0; }
            catch (OverflowException) { return 0; }
        }
    }

    internal static class Native
    {
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

        // Hide the window (SW_HIDE) and drop it out of the always-on-top band.
        public static void ForceHide(IntPtr window)
        {
            ShowWindow(window, 0);
            SetWindowPos(window, (IntPtr)(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0080); // HWND_NOTOPMOST; NOSIZE|NOMOVE|NOACTIVATE|HIDEWINDOW
        }

        // The physical primary button (left, or right when the buttons are swapped). Unlike the
        // window's own input state, this is right even while WebView2 holds the mouse.
        public static bool PrimaryButtonDown()
        {
            int key = SystemInformation.MouseButtonsSwapped ? 0x02 : 0x01;
            return (GetAsyncKeyState(key) & 0x8000) != 0;
        }

        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        // Sharp video on scaled displays: per-monitor DPI (Windows 10 1703+), else system DPI.
        public static void UsePerMonitorDpi()
        {
            try { if (SetProcessDpiAwarenessContext((IntPtr)(-4))) return; }
            catch (EntryPointNotFoundException) { }
            try { SetProcessDPIAware(); }
            catch (EntryPointNotFoundException) { }
        }

        // Windows 11 rounds the corners (DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND); Windows 10 ignores it.
        public static void RoundCorners(IntPtr window)
        {
            int round = 2;
            try { DwmSetWindowAttribute(window, 33, ref round, sizeof(int)); }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }
    }
}

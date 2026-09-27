// Zero Company Mod Command - uninstaller.
//
// Removes Mod Command's OWN files from this PC and leaves the user's installed
// mods exactly where they are. Built by build/build-uninstaller.js with the
// C# 5 compiler that ships with .NET Framework 4.8 (so: no string
// interpolation, no expression-bodied members, no nameof, no ?.).
//
// What Mod Command writes, and what this program therefore offers to remove:
//   %APPDATA%\ZeroCompanyModCommand      settings/store (manager-data.json), the
//                                        Nexus file index, staging\, tools\ and
//                                        any backup folders (main.js resolveDataDir)
//   %APPDATA%\Zero Company Mod Command   Electron's own userData (caches, local
//                                        storage) - named after package.json's
//                                        productName
//   %TEMP%\ZeroCompanyModCommand         the portable stub's unpack folder
//                                        (package.json build.portable.unpackDirName)
//   %TEMP%\zc-retoc, zc-retoc-x-*        retoc update download/extract scratch
//   <archive>                            the mod archive: library\ + backups\ +
//                                        versions\ + a mirrored manifest. Default
//                                        <game>\ModCommandArchive; settings.storageDir
//                                        overrides (lib/storage.js resolveStorageRoot);
//                                        pre-1.9.0 name <game>\ZeroCompanyModArchive
//   steamapps\appmanifest_2075800.acf    the update freeze (lib/steam.js
//                                        setUpdateFreeze): read-only +
//                                        "AutoUpdateBehavior" "1"
//   HKCU\Software\Classes\nxm            the nxm:// handler (main.js 'register-nxm')
//   ZeroCompanyModCommand.exe            the portable exe next to this uninstaller
//
// NEVER touched: the game's mod folders (Content\Paks\~mods, Content\Paks\LogicMods,
// Binaries\Win64 incl. ue4ss\ and ue4ss\Mods\mods.txt, SWZeroCompany\Mods) and any
// game file a mod replaced; %LOCALAPPDATA%\SWZeroCompany (the game's own config).
//
// Command line (all switches are case-insensitive; '-' works as well as '/'):
//   /silent          no dialog; remove everything ticked by default; exit code
//                    0 = done, 1 = something failed, 2 = Mod Command is running
//   /dry-run         print the plan (stdout, or a message box without a console);
//                    deletes nothing
//   /keep-archive    leave the mod archive in place
// Test-only overrides (any of them = TEST MODE: no Steam discovery, and every
// location that was NOT overridden is left out of the plan, so a test can
// never reach the real machine):
//   /appdata:<dir>   stands in for %APPDATA%   (the folder that CONTAINS ZeroCompanyModCommand)
//   /temp:<dir>      stands in for %TEMP%      (the folder that CONTAINS ZeroCompanyModCommand)
//   /game:<dir>      the game folder
//   /regroot:<key>   HKCU subkey under which Software\Classes\nxm is looked up
//   /screenshot:<png> render the dialog to a PNG and exit (no changes)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Zero Company Mod Command Uninstaller")]
[assembly: AssemblyProduct("Zero Company Mod Command Uninstaller")]
[assembly: AssemblyDescription("Zero Company Mod Command Uninstaller")]
[assembly: AssemblyCompany("Envian Mods")]
[assembly: AssemblyCopyright("Envian Mods - MIT License")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyInformationalVersion("1.0.0")]
// Opts the exe into .NET 4.6.2+ path handling (long paths, \\?\ prefixes).
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace EnvianMods.ZeroCompanyModCommand.Uninstall
{
    internal static class Names
    {
        public const string AppDataDir = "ZeroCompanyModCommand";          // main.js APPDATA_DIR_NAME
        public const string ElectronDir = "Zero Company Mod Command";     // Electron userData (productName)
        public const string TempDir = "ZeroCompanyModCommand";            // build.portable.unpackDirName
        public const string ArchiveDir = "ModCommandArchive";             // lib/storage.js ARCHIVE_DIR_NAME
        public const string LegacyArchiveDir = "ZeroCompanyModArchive";   // lib/storage.js LEGACY_ARCHIVE_DIR_NAME
        public const string AppExe = "ZeroCompanyModCommand.exe";         // build.portable.artifactName
        public const string AppId = "2075800";
        public const string GameDirName = "Star Wars Zero Company";
        public const string GameExeRel = @"SWZeroCompany\Binaries\Win64\SWZeroCompany.exe";
        public static readonly string[] ProcessNames = { "ZeroCompanyModCommand", "Zero Company Mod Command" };
        public const string NotTouched = @"NOT touched: your mods in SWZeroCompany\Content\Paks\~mods, LogicMods, Binaries\Win64\ue4ss, SWZeroCompany\Mods and any replaced game files.";
        public const string ArchiveNote = "Your installed mods stay in the game folder and keep working. Without the archive, Mod Command cannot restore originals of game files it replaced; verify game files in Steam if you ever need that.";
    }

    internal sealed class Options
    {
        public bool Silent, DryRun, KeepArchive;
        public string AppData, Temp, Game, RegRoot, Screenshot;
        public bool TestMode { get { return AppData != null || Temp != null || Game != null || RegRoot != null; } }

        public static Options Parse(string[] args)
        {
            var o = new Options();
            foreach (var raw in args)
            {
                if (string.IsNullOrEmpty(raw) || (raw[0] != '/' && raw[0] != '-')) continue;
                var a = raw.Substring(1);
                if (a.StartsWith("-")) a = a.Substring(1);
                int colon = a.IndexOf(':');
                var name = (colon < 0 ? a : a.Substring(0, colon)).ToLowerInvariant();
                var val = colon < 0 ? null : a.Substring(colon + 1).Trim('"');
                switch (name)
                {
                    case "silent": case "s": case "quiet": o.Silent = true; break;
                    case "dry-run": case "dryrun": o.DryRun = true; break;
                    case "keep-archive": o.KeepArchive = true; break;
                    case "appdata": o.AppData = val; break;
                    case "temp": o.Temp = val; break;
                    case "game": o.Game = val; break;
                    case "regroot": o.RegRoot = val ?? ""; break;
                    case "screenshot": o.Screenshot = val; break;
                }
            }
            return o;
        }
    }

    // One row of the dialog.
    internal sealed class Item
    {
        public string Key, Title, Note;
        public List<string> Details = new List<string>();
        public bool Present, DefaultOn, Selected;
    }

    internal sealed class Plan
    {
        public Options Opt;
        public string AppDataRoot, TempRoot, SelfPath, SelfDir, DataDir;
        public string GamePath, GameSource, ArchiveRoot, ManifestPath, ManifestBehavior, NxmSubKey, NxmCommand, AppExePath;
        public bool ArchiveCustom, ArchiveInData, ManifestReadOnly, NxmOwned;
        public List<string> DataTargets = new List<string>();     // whole folders
        public List<string> TempTargets = new List<string>();     // whole folders
        public List<string> ArchiveDirs = new List<string>();     // whole folders
        public List<string> ArchiveFiles = new List<string>();    // single files (custom archive mirror)
        public string ArchiveRootToPrune;                         // custom root: removed only when empty
        public List<string> ExeFiles = new List<string>();
        public List<string> ExeDirs = new List<string>();
        public List<Item> Items = new List<Item>();

        public Item Get(string key) { return Items.First(i => i.Key == key); }
    }

    internal static class Program
    {
        [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);
        [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);

        static bool consoleReady;

        static void Out(string line)
        {
            if (!consoleReady)
            {
                consoleReady = true;
                var h = GetStdHandle(-11);
                if (h == IntPtr.Zero || h == new IntPtr(-1)) AttachConsole(-1);
            }
            try { Console.Out.WriteLine(line); Console.Out.Flush(); } catch (Exception) { }
        }

        static bool HasConsole()
        {
            var h = GetStdHandle(-11);
            if (h != IntPtr.Zero && h != new IntPtr(-1)) return true;
            if (AttachConsole(-1)) { consoleReady = true; return true; }
            return false;
        }

        [STAThread]
        static int Main(string[] args)
        {
            // Long paths: mod libraries can nest deeper than MAX_PATH.
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);

            var opt = Options.Parse(args);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Mod Command must be closed: its files are open while it runs.
            while (RunningApp())
            {
                if (opt.Silent || opt.DryRun || opt.Screenshot != null)
                {
                    if (opt.Screenshot == null)
                    {
                        Out("Zero Company Mod Command is running. Close it and run the uninstaller again.");
                        if (!opt.DryRun) return 2;
                    }
                    break; // a dry run or screenshot changes nothing; it may go on
                }
                var r = MessageBox.Show(
                    "Zero Company Mod Command is running.\n\nClose it (and wait for its window to disappear), then press Retry.",
                    "Uninstall Zero Company Mod Command", MessageBoxButtons.RetryCancel, MessageBoxIcon.Warning);
                if (r != DialogResult.Retry) return 2;
            }

            Plan plan;
            try { plan = Detect(opt); }
            catch (Exception e)
            {
                if (opt.Silent || opt.DryRun) Out("Could not read this PC's Mod Command setup: " + e.Message);
                else MessageBox.Show("Could not read this PC's Mod Command setup:\n\n" + e.Message, "Uninstall Zero Company Mod Command", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            if (opt.DryRun)
            {
                var text = PlanText(plan);
                if (opt.Silent || HasConsole()) { foreach (var l in text.Split('\n')) Out(l.TrimEnd('\r')); }
                else MessageBox.Show(text, "Uninstall Zero Company Mod Command - dry run", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }

            if (opt.Screenshot != null)
            {
                using (var f = new MainForm(plan))
                {
                    f.Shown += delegate
                    {
                        Application.DoEvents();
                        using (var bmp = new Bitmap(f.Width, f.Height))
                        {
                            f.DrawToBitmap(bmp, new Rectangle(0, 0, f.Width, f.Height));
                            bmp.Save(opt.Screenshot, ImageFormat.Png);
                        }
                        f.Close();
                    };
                    f.ShowDialog();
                }
                return 0;
            }

            if (opt.Silent)
            {
                foreach (var it in plan.Items) it.Selected = it.Present && it.DefaultOn;
                var res = Execute(plan);
                foreach (var l in res.Removed) Out("REMOVED  " + l);
                foreach (var l in res.Failed) Out("FAILED   " + l);
                if (res.Removed.Count == 0 && res.Failed.Count == 0) Out("Nothing of Zero Company Mod Command was found to remove.");
                Out(Names.NotTouched);
                if (plan.Get("exe").Selected) ScheduleSelfDelete(plan.SelfPath);
                return res.Failed.Count == 0 ? 0 : 1;
            }

            using (var form = new MainForm(plan))
            {
                if (form.ShowDialog() != DialogResult.OK) return 0;
            }
            var result = Execute(plan);
            var sb = new StringBuilder();
            if (result.Removed.Count > 0)
            {
                sb.AppendLine("Removed:");
                foreach (var l in result.Removed) sb.AppendLine("  - " + l);
            }
            if (result.Failed.Count > 0)
            {
                if (sb.Length > 0) sb.AppendLine();
                sb.AppendLine("Could not remove:");
                foreach (var l in result.Failed) sb.AppendLine("  - " + l);
            }
            if (sb.Length == 0) sb.AppendLine("Nothing was selected, so nothing was removed.");
            sb.AppendLine();
            sb.AppendLine(Names.NotTouched);
            MessageBox.Show(sb.ToString(), "Uninstall Zero Company Mod Command",
                MessageBoxButtons.OK, result.Failed.Count == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            if (plan.Get("exe").Selected) ScheduleSelfDelete(plan.SelfPath);
            return result.Failed.Count == 0 ? 0 : 1;
        }

        internal static bool RunningApp()
        {
            foreach (var n in Names.ProcessNames)
            {
                Process[] ps;
                try { ps = Process.GetProcessesByName(n); } catch (Exception) { continue; }
                bool any = ps.Length > 0;
                foreach (var p in ps) p.Dispose();
                if (any) return true;
            }
            return false;
        }

        static void ScheduleSelfDelete(string self)
        {
            try
            {
                var psi = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & del \"" + self + "\"");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
            }
            catch (Exception) { }
        }

        // ------------------------------------------------------------ detection

        static Plan Detect(Options opt)
        {
            var p = new Plan();
            p.Opt = opt;
            p.SelfPath = Path.GetFullPath(Assembly.GetEntryAssembly().Location);
            p.SelfDir = Path.GetDirectoryName(p.SelfPath);

            if (opt.AppData != null) p.AppDataRoot = Full(opt.AppData);
            else if (!opt.TestMode) p.AppDataRoot = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            if (opt.Temp != null) p.TempRoot = Full(opt.Temp);
            else if (!opt.TestMode) p.TempRoot = Path.GetTempPath();

            // (a) app data + Electron's own userData folder
            Dictionary<string, object> settings = null;
            if (!string.IsNullOrEmpty(p.AppDataRoot))
            {
                p.DataDir = Path.Combine(p.AppDataRoot, Names.AppDataDir);
                if (DirExists(p.DataDir)) p.DataTargets.Add(p.DataDir);
                var electron = Path.Combine(p.AppDataRoot, Names.ElectronDir);
                if (DirExists(electron)) p.DataTargets.Add(electron);
                settings = ReadSettings(Path.Combine(p.DataDir, "manager-data.json"));
            }

            // (b) temp
            if (!string.IsNullOrEmpty(p.TempRoot) && DirExists(p.TempRoot))
            {
                var t = Path.Combine(p.TempRoot, Names.TempDir);
                if (DirExists(t)) p.TempTargets.Add(t);
                var r = Path.Combine(p.TempRoot, "zc-retoc");
                if (DirExists(r)) p.TempTargets.Add(r);
                try
                {
                    foreach (var d in Directory.GetDirectories(p.TempRoot, "zc-retoc-x-*")) p.TempTargets.Add(d);
                }
                catch (Exception) { }
            }

            // (c) game folder + archive
            string gameSetting = Str(settings, "gamePath");
            string storageDir = Str(settings, "storageDir");
            if (opt.Game != null) { p.GamePath = Full(opt.Game); p.GameSource = "command line"; }
            else if (!string.IsNullOrEmpty(gameSetting) && DirExists(gameSetting)) { p.GamePath = Full(gameSetting); p.GameSource = "Mod Command settings"; }
            else if (!opt.TestMode)
            {
                p.GamePath = FindSteamGame();
                if (p.GamePath != null) p.GameSource = "Steam library";
            }

            if (!string.IsNullOrEmpty(storageDir))
            {
                p.ArchiveRoot = Full(storageDir);
                p.ArchiveCustom = true;
            }
            else if (p.GamePath != null) p.ArchiveRoot = Path.Combine(p.GamePath, Names.ArchiveDir);
            else if (p.DataDir != null) { p.ArchiveRoot = p.DataDir; p.ArchiveInData = true; }

            if (p.ArchiveRoot != null)
            {
                if (p.ArchiveInData || p.ArchiveCustom)
                {
                    // Only Mod Command's own pieces: a custom archive may sit in a
                    // folder that also holds other things.
                    foreach (var sub in new[] { "library", "backups", "versions" })
                    {
                        var d = Path.Combine(p.ArchiveRoot, sub);
                        if (DirExists(d)) p.ArchiveDirs.Add(d);
                    }
                    if (p.ArchiveCustom)
                    {
                        foreach (var f in new[] { "manager-data.json", "manager-data.json.tmp" })
                        {
                            var fp = Path.Combine(p.ArchiveRoot, f);
                            if (File.Exists(fp)) p.ArchiveFiles.Add(fp);
                        }
                        p.ArchiveRootToPrune = p.ArchiveRoot;
                    }
                }
                else if (DirExists(p.ArchiveRoot)) p.ArchiveDirs.Add(p.ArchiveRoot);
            }
            if (p.GamePath != null)
            {
                // A default-location archive left behind after moving to a custom
                // one, and the pre-1.9.0 name.
                foreach (var name in new[] { Names.ArchiveDir, Names.LegacyArchiveDir })
                {
                    var d = Path.Combine(p.GamePath, name);
                    if (DirExists(d) && !p.ArchiveDirs.Any(x => Same(x, d))) p.ArchiveDirs.Add(d);
                }
            }

            // (d) update freeze
            p.ManifestPath = FindManifest(p.GamePath, !opt.TestMode);
            if (p.ManifestPath != null)
            {
                try
                {
                    p.ManifestReadOnly = (File.GetAttributes(p.ManifestPath) & FileAttributes.ReadOnly) != 0;
                    var m = Regex.Match(File.ReadAllText(p.ManifestPath), "\"AutoUpdateBehavior\"\\s+\"(\\d)\"");
                    p.ManifestBehavior = m.Success ? m.Groups[1].Value : null;
                }
                catch (Exception) { }
            }

            // (e) nxm:// handler
            if (!opt.TestMode || opt.RegRoot != null)
            {
                p.NxmSubKey = (string.IsNullOrEmpty(opt.RegRoot) ? "" : opt.RegRoot.Trim('\\') + "\\") + @"Software\Classes\nxm";
                try
                {
                    using (var k = Registry.CurrentUser.OpenSubKey(p.NxmSubKey + @"\shell\open\command"))
                    {
                        if (k != null) p.NxmCommand = k.GetValue("") as string;
                    }
                }
                catch (Exception) { }
                var exe = ExeFromCommand(p.NxmCommand);
                p.NxmOwned = exe != null && string.Equals(Path.GetFileName(exe), Names.AppExe, StringComparison.OrdinalIgnoreCase);
            }

            // (f) the exe (and what came in its zip) next to this uninstaller
            p.AppExePath = Path.Combine(p.SelfDir, Names.AppExe);
            if (File.Exists(p.AppExePath))
            {
                p.ExeFiles.Add(p.AppExePath);
                // The release zip's README.txt + CHANGELOG.md go too - but never
                // from a source checkout (Build.bat puts the exe there).
                bool sourceTree = File.Exists(Path.Combine(p.SelfDir, "package.json")) || File.Exists(Path.Combine(p.SelfDir, "main.js"));
                if (!sourceTree)
                {
                    AddIfStartsWith(p.ExeFiles, Path.Combine(p.SelfDir, "README.txt"), "ZERO COMPANY MOD COMMAND");
                    AddIfStartsWith(p.ExeFiles, Path.Combine(p.SelfDir, "CHANGELOG.md"), "# Zero Company Mod Command");
                }
                try
                {
                    foreach (var d in Directory.GetDirectories(p.SelfDir, "ZeroCompanyModCommand-data*"))
                    {
                        var n = Path.GetFileName(d);
                        if (n == "ZeroCompanyModCommand-data" || n.StartsWith("ZeroCompanyModCommand-data.migrated-")) p.ExeDirs.Add(d);
                    }
                }
                catch (Exception) { }
            }

            BuildItems(p);
            return p;
        }

        static void BuildItems(Plan p)
        {
            var data = new Item { Key = "appdata", Title = "App data and settings" };
            data.Present = p.DataTargets.Count > 0;
            data.DefaultOn = true;
            foreach (var d in p.DataTargets) data.Details.Add(d + "  (" + FormatSize(DirSize(d)) + ")");
            if (!data.Present) data.Details.Add(p.DataDir == null ? "(not checked)" : p.DataDir + "  (not found)");
            else data.Note = "Settings, the Nexus sign-in, downloads in progress, tools and caches.";
            p.Items.Add(data);

            var temp = new Item { Key = "temp", Title = "Temporary unpack folder" };
            temp.Present = p.TempTargets.Count > 0;
            temp.DefaultOn = true;
            var retocScratch = new List<string>();
            foreach (var d in p.TempTargets)
            {
                if (Path.GetFileName(d).StartsWith("zc-retoc", StringComparison.OrdinalIgnoreCase)) retocScratch.Add(Path.GetFileName(d));
                else temp.Details.Add(d);
            }
            if (retocScratch.Count > 0 && temp.Details.Count == 0)
                foreach (var n in retocScratch) temp.Details.Add(Path.Combine(p.TempRoot, n) + "  (retoc update download)");
            else if (retocScratch.Count > 0)
                temp.Details.Add("also: " + string.Join(", ", retocScratch) + " (retoc update downloads, same folder)");
            if (!temp.Present) temp.Details.Add(p.TempRoot == null ? "(not checked)" : Path.Combine(p.TempRoot, Names.TempDir) + "  (not found)");
            p.Items.Add(temp);

            var arc = new Item { Key = "archive", Title = "Mod archive (library copies, backups and archived versions)" };
            arc.Present = p.ArchiveDirs.Count > 0 || p.ArchiveFiles.Count > 0;
            arc.DefaultOn = !p.Opt.KeepArchive;
            if (p.ArchiveCustom || p.ArchiveInData)
            {
                long size = p.ArchiveDirs.Sum(d => DirSize(d)) + p.ArchiveFiles.Sum(f => FileSize(f));
                var where = p.ArchiveInData ? " (inside the app data folder)" : "";
                if (arc.Present) arc.Details.Add(p.ArchiveRoot + where + "  (" + FormatSize(size) + ")");
                foreach (var d in p.ArchiveDirs.Where(d => !IsInside(d, p.ArchiveRoot))) arc.Details.Add(d + "  (" + FormatSize(DirSize(d)) + ")");
            }
            else foreach (var d in p.ArchiveDirs) arc.Details.Add(d + "  (" + FormatSize(DirSize(d)) + ")");
            if (!arc.Present)
            {
                if (p.ArchiveRoot != null) arc.Details.Add(p.ArchiveRoot + "  (not found)");
                else arc.Details.Add("(game folder not found)");
            }
            else arc.Note = Names.ArchiveNote;
            p.Items.Add(arc);

            var frz = new Item { Key = "freeze", Title = "Release the game-update freeze on appmanifest_" + Names.AppId + ".acf" };
            // Mod Command's freeze = read-only (lib/steam.js updateFreezeStatus).
            // "AutoUpdateBehavior" "1" alone is also Steam's own "only update
            // when I launch it" choice, so that case is offered but not ticked.
            frz.Present = p.ManifestPath != null && (p.ManifestReadOnly || p.ManifestBehavior == "1");
            frz.DefaultOn = p.ManifestReadOnly;
            if (frz.Present)
            {
                var state = new List<string>();
                if (p.ManifestReadOnly) state.Add("read-only");
                if (p.ManifestBehavior != null) state.Add("AutoUpdateBehavior " + p.ManifestBehavior);
                frz.Details.Add(p.ManifestPath + "  (" + string.Join(", ", state) + ")");
                frz.Note = p.ManifestReadOnly
                    ? "Makes the file writable again and sets AutoUpdateBehavior back to 0, exactly like Mod Command's own unfreeze."
                    : "Not read-only, so this may be your own Steam setting (update only when launched); left unticked.";
            }
            p.Items.Add(frz);

            var nxm = new Item { Key = "nxm", Title = "Remove the nxm:// link handler registration" };
            nxm.Present = p.NxmOwned;
            nxm.DefaultOn = true;
            if (nxm.Present) nxm.Details.Add("HKEY_CURRENT_USER\\" + p.NxmSubKey + "  ->  " + p.NxmCommand);
            p.Items.Add(nxm);

            var exe = new Item { Key = "exe", Title = "Delete " + Names.AppExe + " next to this uninstaller" };
            exe.Present = p.ExeFiles.Count > 0;
            exe.DefaultOn = true;
            if (exe.Present)
            {
                exe.Details.Add(p.AppExePath);
                var also = p.ExeFiles.Skip(1).Select(f => Path.GetFileName(f))
                    .Concat(p.ExeDirs.Select(d => Path.GetFileName(d) + " (old data folder)")).ToList();
                if (also.Count > 0) exe.Details.Add("also here: " + string.Join(", ", also));
            }
            if (exe.Present) exe.Note = "This uninstaller deletes itself as well when it closes.";
            p.Items.Add(exe);

            foreach (var it in p.Items) it.Selected = it.Present && it.DefaultOn;
        }

        static string PlanText(Plan p)
        {
            var sb = new StringBuilder();
            sb.AppendLine("Zero Company Mod Command Uninstaller 1.0.0 - DRY RUN, nothing is deleted.");
            if (p.Opt.TestMode) sb.AppendLine("(test mode: only the overridden locations are considered)");
            sb.AppendLine("Game folder: " + (p.GamePath == null ? "not found" : p.GamePath + "  [" + p.GameSource + "]"));
            foreach (var it in p.Items)
            {
                if (!it.Present && (it.Key == "freeze" || it.Key == "nxm" || it.Key == "exe"))
                {
                    string why = it.Key == "freeze" ? (p.ManifestPath == null ? "no Steam manifest found" : "not frozen")
                        : it.Key == "nxm" ? (p.NxmCommand == null ? "no nxm:// handler registered" : "nxm:// belongs to another program: " + p.NxmCommand)
                        : Names.AppExe + " is not next to this uninstaller";
                    sb.AppendLine("[-] " + it.Title + "  -- " + why);
                    continue;
                }
                sb.AppendLine((it.Selected ? "[x] " : "[ ] ") + it.Title);
                foreach (var d in it.Details) sb.AppendLine("      " + d);
            }
            sb.AppendLine(Names.NotTouched);
            return sb.ToString();
        }

        // ------------------------------------------------------------ execution

        internal sealed class Result
        {
            public List<string> Removed = new List<string>();
            public List<string> Failed = new List<string>();
        }

        static Result Execute(Plan p)
        {
            var res = new Result();
            var archiveSelected = p.Get("archive").Selected;

            if (p.Get("nxm").Selected)
            {
                try
                {
                    // Re-check ownership at the moment of removal.
                    string cmd = null;
                    using (var k = Registry.CurrentUser.OpenSubKey(p.NxmSubKey + @"\shell\open\command"))
                        if (k != null) cmd = k.GetValue("") as string;
                    var exe = ExeFromCommand(cmd);
                    if (exe == null || !string.Equals(Path.GetFileName(exe), Names.AppExe, StringComparison.OrdinalIgnoreCase))
                        res.Failed.Add("nxm:// handler: it no longer points at " + Names.AppExe + ", left alone");
                    else
                    {
                        Registry.CurrentUser.DeleteSubKeyTree(p.NxmSubKey, false);
                        res.Removed.Add("nxm:// handler (HKEY_CURRENT_USER\\" + p.NxmSubKey + ")");
                    }
                }
                catch (Exception e) { res.Failed.Add("nxm:// handler: " + e.Message); }
            }

            if (p.Get("freeze").Selected)
            {
                try
                {
                    Unfreeze(p.ManifestPath);
                    res.Removed.Add("update freeze on " + p.ManifestPath + " (writable, AutoUpdateBehavior 0)");
                }
                catch (Exception e) { res.Failed.Add(p.ManifestPath + ": " + e.Message); }
            }

            if (p.Get("temp").Selected)
                foreach (var d in p.TempTargets) RemoveDir(p, d, null, res);

            if (p.Get("appdata").Selected)
            {
                // An archive that lives inside the data folder stays when unticked.
                List<string> keep = null;
                if (p.ArchiveInData && !archiveSelected) keep = p.ArchiveDirs;
                foreach (var d in p.DataTargets) RemoveDir(p, d, keep, res);
            }

            if (archiveSelected)
            {
                foreach (var d in p.ArchiveDirs) if (DirExists(d)) RemoveDir(p, d, null, res);
                foreach (var f in p.ArchiveFiles) RemoveFile(p, f, res);
                if (p.ArchiveRootToPrune != null && DirExists(p.ArchiveRootToPrune))
                {
                    try
                    {
                        if (!Directory.EnumerateFileSystemEntries(Ext(p.ArchiveRootToPrune)).Any() && Safe(p, p.ArchiveRootToPrune) == null)
                        {
                            Directory.Delete(Ext(p.ArchiveRootToPrune), false);
                            res.Removed.Add(p.ArchiveRootToPrune + " (now empty)");
                        }
                    }
                    catch (Exception) { /* a non-empty custom folder simply stays */ }
                }
            }

            if (p.Get("exe").Selected)
            {
                foreach (var f in p.ExeFiles) RemoveFile(p, f, res);
                foreach (var d in p.ExeDirs) RemoveDir(p, d, null, res);
            }
            return res;
        }

        // Mirrors lib/steam.js setUpdateFreeze(path, false).
        static void Unfreeze(string manifest)
        {
            var attrs = File.GetAttributes(manifest);
            if ((attrs & FileAttributes.ReadOnly) != 0) File.SetAttributes(manifest, attrs & ~FileAttributes.ReadOnly);
            var text = File.ReadAllText(manifest);
            var re = new Regex("\"AutoUpdateBehavior\"\\s+\"\\d\"");
            if (re.IsMatch(text)) text = re.Replace(text, "\"AutoUpdateBehavior\"\t\t\"0\"", 1);
            else text = new Regex("(\"StateFlags\"\\s+\"\\d+\")").Replace(text, "$1\n\t\"AutoUpdateBehavior\"\t\t\"0\"", 1);
            File.WriteAllText(manifest, text, new UTF8Encoding(false));
        }

        static void RemoveDir(Plan p, string dir, List<string> keep, Result res)
        {
            var why = Safe(p, dir);
            if (why != null) { res.Failed.Add(dir + ": refused (" + why + ")"); return; }
            var errors = new List<string>();
            long size = DirSize(dir);
            DeleteTree(dir, keep, errors);
            if (errors.Count == 0)
                res.Removed.Add(dir + (keep != null && DirExists(dir) ? " (archive kept inside)" : "") + "  (" + FormatSize(size) + ")");
            else
                res.Failed.Add(dir + ": " + errors.Count + " item(s) could not be deleted, first: " + errors[0]);
        }

        static void RemoveFile(Plan p, string file, Result res)
        {
            var why = Safe(p, file);
            if (why != null) { res.Failed.Add(file + ": refused (" + why + ")"); return; }
            try
            {
                var x = Ext(file);
                if (!File.Exists(x)) return;
                File.SetAttributes(x, FileAttributes.Normal);
                File.Delete(x);
                res.Removed.Add(file);
            }
            catch (Exception e) { res.Failed.Add(file + ": " + e.Message); }
        }

        // Depth-first delete that never follows a junction or symbolic link:
        // a reparse point is removed as a link, its target is left alone.
        static void DeleteTree(string dir, List<string> keep, List<string> errors)
        {
            if (keep != null && keep.Any(k => Same(k, dir))) return;
            var x = Ext(dir);
            FileAttributes attrs;
            try { attrs = File.GetAttributes(x); }
            catch (Exception e) { errors.Add(dir + ": " + e.Message); return; }
            if ((attrs & FileAttributes.ReparsePoint) != 0)
            {
                try
                {
                    if ((attrs & FileAttributes.ReadOnly) != 0) File.SetAttributes(x, attrs & ~FileAttributes.ReadOnly);
                    Directory.Delete(x, false); // removes the link itself
                }
                catch (Exception e) { errors.Add(dir + ": " + e.Message); }
                return;
            }
            string[] files = new string[0], dirs = new string[0];
            try { files = Directory.GetFiles(x); dirs = Directory.GetDirectories(x); }
            catch (Exception e) { errors.Add(dir + ": " + e.Message); return; }
            foreach (var f in files)
            {
                try { File.SetAttributes(f, FileAttributes.Normal); File.Delete(f); }
                catch (Exception e) { errors.Add(Strip(f) + ": " + e.Message); }
            }
            foreach (var d in dirs) DeleteTree(Strip(d), keep, errors);
            try
            {
                if (keep != null && Directory.EnumerateFileSystemEntries(x).Any()) return; // holds a kept folder
                File.SetAttributes(x, FileAttributes.Normal);
                Directory.Delete(x, false);
            }
            catch (Exception e) { errors.Add(dir + ": " + e.Message); }
        }

        // Returns why a path must not be deleted, or null when it may be.
        static string Safe(Plan p, string target)
        {
            string full;
            try { full = Full(target); } catch (Exception) { return "not a valid path"; }
            var root = Path.GetPathRoot(full);
            if (string.IsNullOrEmpty(root) || Same(root, full)) return "a drive root";
            var guarded = new List<string> { p.GamePath, p.AppDataRoot, p.TempRoot, p.SelfDir };
            foreach (var sf in new[] {
                Environment.SpecialFolder.UserProfile, Environment.SpecialFolder.ApplicationData,
                Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.Windows,
                Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86,
                Environment.SpecialFolder.Desktop, Environment.SpecialFolder.MyDocuments })
            {
                try { guarded.Add(Environment.GetFolderPath(sf)); } catch (Exception) { }
            }
            foreach (var g in guarded)
            {
                if (string.IsNullOrEmpty(g)) continue;
                if (Same(g, full) || IsInside(g, full)) return "it contains " + g;
            }
            if (p.GamePath != null && IsInside(full, p.GamePath))
            {
                var rel = full.Substring(Full(p.GamePath).TrimEnd('\\').Length).TrimStart('\\');
                var first = rel.Split('\\')[0];
                if (!first.Equals(Names.ArchiveDir, StringComparison.OrdinalIgnoreCase)
                    && !first.Equals(Names.LegacyArchiveDir, StringComparison.OrdinalIgnoreCase))
                    return "it is part of the game folder, where your mods live";
            }
            return null;
        }

        // ------------------------------------------------------------ helpers

        static Dictionary<string, object> ReadSettings(string file)
        {
            try
            {
                if (!File.Exists(file)) return null;
                var text = File.ReadAllText(file);
                try
                {
                    var js = new JavaScriptSerializer();
                    js.MaxJsonLength = int.MaxValue;
                    js.RecursionLimit = 256;
                    var root = js.DeserializeObject(text) as Dictionary<string, object>;
                    object s;
                    if (root != null && root.TryGetValue("settings", out s)) return s as Dictionary<string, object>;
                }
                catch (Exception)
                {
                    // Damaged JSON: pull the two keys we need out by hand.
                    var d = new Dictionary<string, object>();
                    foreach (var key in new[] { "gamePath", "storageDir" })
                    {
                        var m = Regex.Match(text, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
                        if (m.Success) d[key] = Regex.Unescape(m.Groups[1].Value);
                    }
                    return d;
                }
            }
            catch (Exception) { }
            return null;
        }

        static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v)) return null;
            var s = v as string;
            return string.IsNullOrWhiteSpace(s) ? null : s;
        }

        // Steam discovery, like lib/steam.js: SteamPath -> libraryfolders.vdf ->
        // the library holding appmanifest_2075800.acf -> common\<installdir>.
        static string FindSteamGame()
        {
            foreach (var lib in SteamLibraries())
            {
                var man = Path.Combine(lib, "appmanifest_" + Names.AppId + ".acf");
                string installdir = Names.GameDirName;
                if (File.Exists(man))
                {
                    try
                    {
                        var m = Regex.Match(File.ReadAllText(man), "\"installdir\"\\s+\"([^\"]*)\"");
                        if (m.Success && m.Groups[1].Value.Length > 0) installdir = m.Groups[1].Value;
                    }
                    catch (Exception) { }
                }
                var candidate = Path.Combine(lib, "common", installdir);
                if (File.Exists(Path.Combine(candidate, Names.GameExeRel))) return candidate;
            }
            return null;
        }

        static List<string> SteamLibraries()
        {
            var libs = new List<string>();
            string root = null;
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam"))
                {
                    var v = k == null ? null : k.GetValue("SteamPath") as string;
                    if (!string.IsNullOrEmpty(v) && Directory.Exists(v.Replace('/', '\\'))) root = v.Replace('/', '\\');
                }
            }
            catch (Exception) { }
            if (root == null)
            {
                foreach (var sf in new[] { Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.ProgramFiles })
                {
                    var g = Path.Combine(Environment.GetFolderPath(sf), "Steam");
                    if (Directory.Exists(g)) { root = g; break; }
                }
            }
            if (root == null) return libs;
            libs.Add(Path.Combine(root, "steamapps"));
            try
            {
                var vdf = File.ReadAllText(Path.Combine(root, @"steamapps\libraryfolders.vdf"));
                foreach (Match m in Regex.Matches(vdf, "\"path\"\\s+\"([^\"]+)\""))
                {
                    var lib = Path.Combine(m.Groups[1].Value.Replace(@"\\", @"\"), "steamapps");
                    if (Directory.Exists(lib) && !libs.Any(l => Same(l, lib))) libs.Add(lib);
                }
            }
            catch (Exception) { }
            return libs;
        }

        // Like lib/steam.js attachManifest: <library>\steamapps\common\<game> has
        // its manifest right there; otherwise ask the Steam libraries.
        static string FindManifest(string game, bool scanSteam)
        {
            if (game == null) return null;
            var common = Path.GetDirectoryName(game.TrimEnd('\\'));
            var steamapps = common == null ? null : Path.GetDirectoryName(common);
            if (common != null && steamapps != null
                && Path.GetFileName(common).Equals("common", StringComparison.OrdinalIgnoreCase)
                && Path.GetFileName(steamapps).Equals("steamapps", StringComparison.OrdinalIgnoreCase))
            {
                var m = Path.Combine(steamapps, "appmanifest_" + Names.AppId + ".acf");
                if (File.Exists(m)) return m;
            }
            if (!scanSteam) return null;
            foreach (var lib in SteamLibraries())
            {
                var m = Path.Combine(lib, "appmanifest_" + Names.AppId + ".acf");
                if (File.Exists(m)) return m;
            }
            return null;
        }

        // First token of a shell\open\command value: "C:\x\y.exe" "%1" -> C:\x\y.exe
        static string ExeFromCommand(string cmd)
        {
            if (string.IsNullOrWhiteSpace(cmd)) return null;
            cmd = cmd.Trim();
            if (cmd.StartsWith("\""))
            {
                int end = cmd.IndexOf('"', 1);
                return end > 1 ? cmd.Substring(1, end - 1) : null;
            }
            int exe = cmd.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
            if (exe > 0) return cmd.Substring(0, exe + 4);
            int sp = cmd.IndexOf(' ');
            return sp > 0 ? cmd.Substring(0, sp) : cmd;
        }

        static void AddIfStartsWith(List<string> list, string file, string prefix)
        {
            try
            {
                if (!File.Exists(file)) return;
                using (var r = new StreamReader(file))
                {
                    var first = r.ReadLine();
                    if (first != null && first.TrimStart('\uFEFF').StartsWith(prefix, StringComparison.Ordinal)) list.Add(file);
                }
            }
            catch (Exception) { }
        }

        // Absolute, unprefixed, no trailing separator (except a drive root).
        internal static string Full(string p)
        {
            var f = Strip(Path.GetFullPath(p));
            if (f.Length > 3) f = f.TrimEnd('\\');
            return f;
        }

        static string Ext(string p)
        {
            p = Path.GetFullPath(p);
            if (p.StartsWith(@"\\?\")) return p;
            if (p.StartsWith(@"\\")) return @"\\?\UNC\" + p.Substring(2);
            return @"\\?\" + p;
        }

        static string Strip(string p)
        {
            if (p.StartsWith(@"\\?\UNC\")) return @"\\" + p.Substring(8);
            if (p.StartsWith(@"\\?\")) return p.Substring(4);
            return p;
        }

        static bool Same(string a, string b)
        {
            return string.Equals(Strip(Path.GetFullPath(a)).TrimEnd('\\'), Strip(Path.GetFullPath(b)).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }

        // Is `child` strictly inside `parent`?
        static bool IsInside(string child, string parent)
        {
            var c = Strip(Path.GetFullPath(child)).TrimEnd('\\') + "\\";
            var p = Strip(Path.GetFullPath(parent)).TrimEnd('\\') + "\\";
            return c.Length > p.Length && c.StartsWith(p, StringComparison.OrdinalIgnoreCase);
        }

        static bool DirExists(string p)
        {
            try { return !string.IsNullOrEmpty(p) && Directory.Exists(Ext(p)); } catch (Exception) { return false; }
        }

        static long FileSize(string f)
        {
            try { return new FileInfo(Ext(f)).Length; } catch (Exception) { return 0; }
        }

        // Size without following junctions/links.
        static long DirSize(string dir)
        {
            long total = 0;
            try
            {
                var di = new DirectoryInfo(Ext(dir));
                if ((di.Attributes & FileAttributes.ReparsePoint) != 0) return 0;
                foreach (var f in di.GetFiles()) total += f.Length;
                foreach (var d in di.GetDirectories())
                    if ((d.Attributes & FileAttributes.ReparsePoint) == 0) total += DirSize(Strip(d.FullName));
            }
            catch (Exception) { }
            return total;
        }

        internal static string FormatSize(long bytes)
        {
            if (bytes < 1024 * 1024) return (bytes / 1024.0).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture) + " KB";
            if (bytes < 1024L * 1024 * 1024) return (bytes / (1024.0 * 1024)).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture) + " MB";
            return (bytes / (1024.0 * 1024 * 1024)).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + " GB";
        }
    }

    // ---------------------------------------------------------------- dialog

    internal sealed class MainForm : Form
    {
        readonly Plan plan;
        readonly Dictionary<string, CheckBox> boxes = new Dictionary<string, CheckBox>();

        public MainForm(Plan p)
        {
            plan = p;
            Text = "Uninstall Zero Company Mod Command";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.None; // layout below is measured, not scaled
            Font = new Font("Segoe UI", 9f);
            BackColor = SystemColors.Window;
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetEntryAssembly().Location); } catch (Exception) { }

            float s;
            using (var g = CreateGraphics()) s = g.DpiX / 96f;
            int pad = (int)(16 * s), indent = (int)(22 * s), width = (int)(640 * s);
            int y = pad;

            var bold = new Font(Font, FontStyle.Bold);
            var dim = Color.FromArgb(90, 90, 90);

            // Items scroll inside `content` when they would not fit on the
            // screen; the "NOT touched" line and the buttons always show.
            var content = new Panel { AutoScroll = true, Location = new Point(0, 0) };
            Controls.Add(content);

            var head = new Label { AutoSize = true, Font = new Font("Segoe UI", 12f, FontStyle.Bold), Text = "Uninstall Zero Company Mod Command", Location = new Point(pad, y) };
            content.Controls.Add(head);
            y += head.PreferredHeight + (int)(6 * s);

            AddLabel(content, "This removes Zero Company Mod Command's own files from this PC. Your installed mods stay in the game folder and keep working. Choose what to remove:", Font, SystemColors.ControlText, pad, ref y, width);
            y += (int)(8 * s);

            foreach (var it in p.Items)
            {
                bool optional = it.Key == "freeze" || it.Key == "nxm" || it.Key == "exe";
                if (optional && !it.Present) continue; // shown only when there is something to undo
                var cb = new CheckBox
                {
                    AutoSize = true,
                    Text = it.Title,
                    Font = bold,
                    Checked = it.Present && it.DefaultOn,
                    Enabled = it.Present,
                    Location = new Point(pad, y),
                    Tag = it,
                    UseMnemonic = false,
                };
                content.Controls.Add(cb);
                boxes[it.Key] = cb;
                y += cb.PreferredSize.Height + (int)(1 * s);
                AddLabel(content, string.Join("\n", it.Details), Font, dim, pad + indent, ref y, width - indent);
                if (!string.IsNullOrEmpty(it.Note))
                {
                    y += (int)(2 * s);
                    AddLabel(content, it.Note, new Font(Font, FontStyle.Italic), it.Key == "archive" ? Color.FromArgb(150, 90, 0) : dim, pad + indent, ref y, width - indent);
                }
                y += (int)(10 * s);
            }
            int contentHeight = y;

            // Footer, measured first so the content height can be capped.
            int fy = (int)(6 * s);
            var notTouched = AddLabel(this, Names.NotTouched, bold, Color.FromArgb(0, 110, 40), pad, ref fy, width);
            fy += (int)(14 * s);
            var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true, MinimumSize = new Size((int)(96 * s), (int)(30 * s)) };
            var go = new Button { Text = "Uninstall", AutoSize = true, MinimumSize = new Size((int)(96 * s), (int)(30 * s)) };
            go.Click += OnUninstall;
            Controls.Add(cancel);
            Controls.Add(go);
            int buttonsHeight = Math.Max(cancel.PreferredSize.Height, go.PreferredSize.Height);
            int footerHeight = fy + buttonsHeight + pad;

            int screenHeight = Screen.FromPoint(Cursor.Position).WorkingArea.Height;
            int maxContent = Math.Max((int)(220 * s), screenHeight - SystemInformation.CaptionHeight - (int)(40 * s) - footerHeight);
            int panelHeight = Math.Min(contentHeight, maxContent);
            int scrollBar = panelHeight < contentHeight ? SystemInformation.VerticalScrollBarWidth : 0;
            content.Size = new Size(width + 2 * pad + scrollBar, panelHeight);

            notTouched.Top += panelHeight;
            cancel.Location = new Point(pad + width + scrollBar - cancel.PreferredSize.Width, panelHeight + fy);
            go.Location = new Point(cancel.Left - (int)(8 * s) - go.PreferredSize.Width, panelHeight + fy);
            CancelButton = cancel;

            ClientSize = new Size(width + 2 * pad + scrollBar, panelHeight + footerHeight);
            ActiveControl = cancel;
        }

        Label AddLabel(Control parent, string text, Font font, Color color, int x, ref int y, int maxWidth)
        {
            var l = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(maxWidth, 0),
                Text = text,
                Font = font,
                ForeColor = color,
                Location = new Point(x, y),
                UseMnemonic = false,
            };
            parent.Controls.Add(l);
            y += l.GetPreferredSize(new Size(maxWidth, 0)).Height;
            return l;
        }

        void OnUninstall(object sender, EventArgs e)
        {
            if (Program.RunningApp())
            {
                MessageBox.Show(this, "Zero Company Mod Command is running. Close it first, then press Uninstall again.",
                    Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            foreach (var it in plan.Items)
            {
                CheckBox cb;
                it.Selected = it.Present && boxes.TryGetValue(it.Key, out cb) && cb.Checked;
            }
            if (!plan.Items.Any(i => i.Selected))
            {
                MessageBox.Show(this, "Nothing is ticked.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            DialogResult = DialogResult.OK;
            Close();
        }
    }
}

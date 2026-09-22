// OpenAcom Desktop: shared Hub protocol client and legacy headless diagnostics. Normal startup uses ModernDesktop.cs and its WPF shell.
//
// Built with the compiler that already ships inside Windows
// (%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe), which is a C# 5
// compiler: no interpolated strings, no ?., no nameof, no expression-bodied
// members anywhere below. Nothing is downloaded and no third-party assembly is
// referenced, so the only JSON handling here is the small reader/writer in Json.
//
// Every request goes to a loopback hub URL and carries the operator's bearer
// token in a header. The token is never rendered, logged or written to disk by
// this program; only its SHA-256 fingerprint (first 8 hex chars, the same
// shape the hub itself publishes for node credentials) is ever displayed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace OpenAcom.Desktop
{
    internal static class Program
    {
        // Started before anything else so --bench can report process-start to
        // first-paint, which is the number the "startup under 2s" bar means.
        internal static readonly Stopwatch Elapsed = Stopwatch.StartNew();

        [STAThread]
        private static int Main(string[] args)
        {
            ServicePointManager.Expect100Continue = false;
            ServicePointManager.DefaultConnectionLimit = 4;
            Options opts;
            try
            {
                opts = Options.Parse(args);
            }
            catch (Exception ex)
            {
                Fail(opts_out(args), 2, "argument error: " + ex.Message);
                return 2;
            }
            if (opts.Help)
            {
                Emit(opts.OutPath, Usage());
                return 0;
            }
            if (!opts.SelfTest && !opts.LiveTest && !opts.Bench) return ModernShell.Run(opts);
            Config cfg;
            try
            {
                cfg = Config.Discover(opts);
            }
            catch (Exception ex)
            {
                Fail(opts.OutPath, 2, "config error: " + ex.Message);
                return 2;
            }
            if (opts.SelfTest) return SelfTest.Run(cfg, opts);
            if (opts.LiveTest) return LiveTest.Run(cfg, opts);
            if (opts.Bench) return Bench.Run(cfg, opts);

            bool createdNew;
            // Held for the whole process lifetime; a finalized mutex would let a
            // second window open while the first is still up.
            using (Mutex mutex = new Mutex(true, "OpenAcom.Desktop.SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("OpenAcom Desktop is already running.", "OpenAcom Desktop",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 3;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(cfg));
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        private static string opts_out(string[] args)
        {
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--out") return args[i + 1];
            return null;
        }

        internal static void Emit(string path, string text)
        {
            // A winexe has no console of its own, and on a legacy code page the
            // UTF-8 text would come out as mojibake - so when --out is given the
            // file is the only output that matters.
            if (path == null)
            {
                try { Console.Out.Write(text); }
                catch (Exception) { }
                return;
            }
            try { File.WriteAllText(path, text, new UTF8Encoding(false)); }
            catch (Exception ex) { try { Console.Error.WriteLine("cannot write --out: " + ex.Message); } catch (Exception) { } }
        }

        // A winexe has no attached console, so failures that happen before a
        // window exists still have to land somewhere the caller can read.
        internal static void Fail(string path, int code, string message)
        {
            Emit(path, "{\n  \"ok\": false,\n  \"code\": " + code.ToString(CultureInfo.InvariantCulture)
                + ",\n  \"error\": " + Json.Quote(message) + "\n}\n");
        }

        internal static string Usage()
        {
            return "OpenAcom Desktop (loopback hub client)\n"
                + "  openacom-desktop.exe                       open the window\n"
                + "  openacom-desktop.exe --selftest --out F    headless check against a stub hub (creates no window)\n"
                + "  openacom-desktop.exe --livetest --out F    headless check against a real hub (creates no window)\n"
                + "  openacom-desktop.exe --bench --out F [--hold MS]  measure startup + private bytes, then exit\n"
                + "  --url URL        hub base URL        (default $AGENTRELAY_URL or http://127.0.0.1:9330)\n"
                + "  --token-file P   read the bearer token from P (default $AGENTRELAY_TOKEN, then <home>\\relay.token)\n"
                + "  --interval SEC   auto refresh period, 1..60 (default 5)\n"
                + "  <home> = $AGENTRELAY_HOME or %USERPROFILE%\\.openacom\n";
        }
    }

    internal sealed class Options
    {
        internal bool UiSmoke;
        internal bool SelfTest;
        internal bool LiveTest;
        internal bool Bench;
        internal bool Help;
        internal string Url;
        internal string Token;
        internal string TokenFile;
        internal string OutPath;
        internal string ShotPath;
        internal int IntervalSeconds = 5;
        internal int HoldMs = 1200;

        internal static Options Parse(string[] args)
        {
            Options o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                switch (a)
                {
                    case "--ui-smoke": o.UiSmoke = true; break;
                    case "--selftest": o.SelfTest = true; break;
                    case "--livetest": o.LiveTest = true; break;
                    case "--bench": o.Bench = true; break;
                    case "--help": o.Help = true; break;
                    case "--url": o.Url = Next(args, ref i, a); break;
                    case "--token": o.Token = Next(args, ref i, a); break;
                    case "--token-file": o.TokenFile = Next(args, ref i, a); break;
                    case "--out": o.OutPath = Next(args, ref i, a); break;
                    case "--shot": o.ShotPath = Next(args, ref i, a); break;
                    case "--interval": o.IntervalSeconds = int.Parse(Next(args, ref i, a), CultureInfo.InvariantCulture); break;
                    case "--hold": o.HoldMs = int.Parse(Next(args, ref i, a), CultureInfo.InvariantCulture); break;
                    default: throw new ArgumentException("unknown option " + a);
                }
            }
            int modes = (o.SelfTest ? 1 : 0) + (o.LiveTest ? 1 : 0) + (o.Bench ? 1 : 0);
            if (modes > 1) throw new ArgumentException("--selftest, --livetest and --bench are exclusive");
            if (o.IntervalSeconds < 1 || o.IntervalSeconds > 60) throw new ArgumentException("--interval must be 1..60");
            if (o.HoldMs < 0 || o.HoldMs > 120000) throw new ArgumentException("--hold must be 0..120000");
            return o;
        }

        private static string Next(string[] args, ref int i, string flag)
        {
            if (i + 1 >= args.Length) throw new ArgumentException(flag + " requires a value");
            return args[++i];
        }
    }

    internal sealed class Config
    {
        internal string Url;
        internal string Token;
        internal string TokenFingerprint;
        internal string TokenSource;
        internal string Home;
        internal int IntervalSeconds;
        internal int TimeoutMs = 4000;

        internal static Config Discover(Options opts)
        {
            Config c = new Config();
            c.IntervalSeconds = opts.IntervalSeconds;
            c.Home = FirstNonEmpty(Environment.GetEnvironmentVariable("AGENTRELAY_HOME"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".openacom"));

            // Same discovery order the CLI uses (lib/distributed-cli.js):
            // explicit flag, then AGENTRELAY_URL, then the loopback default.
            string url = FirstNonEmpty(opts.Url, Environment.GetEnvironmentVariable("AGENTRELAY_URL"), "http://127.0.0.1:9330");
            Uri parsed;
            if (!Uri.TryCreate(url, UriKind.Absolute, out parsed)) throw new ArgumentException("hub URL is not absolute: " + Redact.Scrub(url));
            if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) throw new ArgumentException("hub URL must be http or https");
            if (!IsLoopback(parsed.Host))
            {
                throw new ArgumentException("refusing to send the hub token to non-loopback host " + parsed.Host
                    + "; use SSH forwarding or a TLS reverse proxy as the CLI help states");
            }
            c.Url = parsed.GetLeftPart(UriPartial.Authority);

            string tokenFile = opts.TokenFile;
            string token = opts.Token;
            string source = "--token";
            if (string.IsNullOrEmpty(token))
            {
                token = Environment.GetEnvironmentVariable("AGENTRELAY_TOKEN");
                source = "env AGENTRELAY_TOKEN";
            }
            if (string.IsNullOrEmpty(token) && string.IsNullOrEmpty(tokenFile))
            {
                string candidate = Path.Combine(c.Home, "relay.token");
                if (File.Exists(candidate)) { tokenFile = candidate; source = "file " + candidate; }
            }
            if (string.IsNullOrEmpty(token) && !string.IsNullOrEmpty(tokenFile))
            {
                if (!File.Exists(tokenFile)) throw new ArgumentException("token file not found: " + tokenFile);
                token = File.ReadAllText(tokenFile, Encoding.UTF8).Trim();
                source = "file " + tokenFile;
            }
            if (string.IsNullOrEmpty(token))
            {
                throw new ArgumentException("no hub credential found: set AGENTRELAY_TOKEN, or pass --token-file, "
                    + "or put the token in " + Path.Combine(c.Home, "relay.token"));
            }
            // The hub rejects anything outside this shape, so say so here instead
            // of letting every request come back 401.
            if (!Regex.IsMatch(token, @"^[\x21-\x7e]{32,4096}$"))
            {
                throw new ArgumentException("hub token must be 32..4096 printable non-space ASCII characters (got "
                    + token.Length.ToString(CultureInfo.InvariantCulture) + ")");
            }
            c.Token = token;
            c.TokenSource = source;
            c.TokenFingerprint = Fingerprint(token);
            return c;
        }

        internal static string Fingerprint(string token)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(token));
                StringBuilder sb = new StringBuilder(8);
                for (int i = 0; i < 4; i++) sb.Append(digest[i].ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        private static bool IsLoopback(string host)
        {
            if (string.IsNullOrEmpty(host)) return false;
            string h = host.TrimStart('[').TrimEnd(']');
            return h == "127.0.0.1" || h == "localhost" || h == "::1" || h == "[::1]"
                || h.StartsWith("127.", StringComparison.Ordinal) || h.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase);
        }

        private static string FirstNonEmpty(params string[] values)
        {
            foreach (string v in values) if (!string.IsNullOrEmpty(v)) return v;
            return null;
        }
    }

    // Anything that could reach the UI, a report or stderr passes through here,
    // so a URL or exception message that somehow carries the token cannot leak it.
    internal static class Redact
    {
        // More than one because the selftest also builds a deliberately wrong
        // credential to prove a 401 is surfaced; neither value may reach a report.
        private static readonly List<string> Secrets = new List<string>(2);

        internal static void SetSecret(string token)
        {
            if (string.IsNullOrEmpty(token)) return;
            lock (Secrets) { if (!Secrets.Contains(token)) Secrets.Add(token); }
        }

        internal static string Scrub(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            string s = text;
            lock (Secrets)
            {
                foreach (string secret in Secrets)
                {
                    if (s.IndexOf(secret, StringComparison.Ordinal) >= 0) s = s.Replace(secret, "[redacted]");
                }
            }
            return s;
        }
    }

    internal static class Json
    {
        internal static object Parse(string text)
        {
            int i = 0;
            object value = Value(text, ref i);
            White(text, ref i);
            if (i != text.Length) throw new FormatException("trailing JSON at offset " + i.ToString(CultureInfo.InvariantCulture));
            return value;
        }

        internal static string Quote(string s)
        {
            StringBuilder sb = new StringBuilder(s == null ? 2 : s.Length + 2);
            WriteString(sb, s);
            return sb.ToString();
        }

        internal static string Write(object value)
        {
            StringBuilder sb = new StringBuilder(128);
            WriteValue(sb, value);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object value)
        {
            if (value == null) { sb.Append("null"); return; }
            List<KeyValuePair<string, object>> pairs = value as List<KeyValuePair<string, object>>;
            if (pairs != null)
            {
                sb.Append('{');
                for (int i = 0; i < pairs.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    WriteString(sb, pairs[i].Key);
                    sb.Append(':');
                    WriteValue(sb, pairs[i].Value);
                }
                sb.Append('}');
                return;
            }
            IDictionary<string, object> map = value as IDictionary<string, object>;
            if (map != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (KeyValuePair<string, object> kv in map)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, kv.Key);
                    sb.Append(':');
                    WriteValue(sb, kv.Value);
                }
                sb.Append('}');
                return;
            }
            System.Collections.IEnumerable list = value as System.Collections.IEnumerable;
            if (list != null && !(value is string))
            {
                sb.Append('[');
                bool first = true;
                foreach (object item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteValue(sb, item);
                }
                sb.Append(']');
                return;
            }
            if (value is string) { WriteString(sb, (string)value); return; }
            if (value is bool) { sb.Append(((bool)value) ? "true" : "false"); return; }
            if (value is long) { sb.Append(((long)value).ToString(CultureInfo.InvariantCulture)); return; }
            if (value is int) { sb.Append(((int)value).ToString(CultureInfo.InvariantCulture)); return; }
            if (value is double) { sb.Append(((double)value).ToString("R", CultureInfo.InvariantCulture)); return; }
            sb.Append(Quote(value.ToString()));
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            if (s != null)
            {
                for (int i = 0; i < s.Length; i++)
                {
                    char ch = s[i];
                    switch (ch)
                    {
                        case '"': sb.Append("\\\""); break;
                        case '\\': sb.Append("\\\\"); break;
                        case '\n': sb.Append("\\n"); break;
                        case '\r': sb.Append("\\r"); break;
                        case '\t': sb.Append("\\t"); break;
                        case '\b': sb.Append("\\b"); break;
                        case '\f': sb.Append("\\f"); break;
                        default:
                            if (ch < ' ') sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                            else sb.Append(ch);
                            break;
                    }
                }
            }
            sb.Append('"');
        }

        private static void White(string t, ref int i)
        {
            while (i < t.Length && (t[i] == ' ' || t[i] == '\t' || t[i] == '\n' || t[i] == '\r')) i++;
        }

        private static object Value(string t, ref int i)
        {
            White(t, ref i);
            if (i >= t.Length) throw new FormatException("unexpected end of JSON");
            char ch = t[i];
            if (ch == '{') return Object(t, ref i);
            if (ch == '[') return Array(t, ref i);
            if (ch == '"') return String(t, ref i);
            if (ch == 't') { Expect(t, ref i, "true"); return true; }
            if (ch == 'f') { Expect(t, ref i, "false"); return false; }
            if (ch == 'n') { Expect(t, ref i, "null"); return null; }
            return Number(t, ref i);
        }

        private static void Expect(string t, ref int i, string literal)
        {
            if (i + literal.Length > t.Length || string.CompareOrdinal(t, i, literal, 0, literal.Length) != 0)
            {
                throw new FormatException("expected " + literal + " at offset " + i.ToString(CultureInfo.InvariantCulture));
            }
            i += literal.Length;
        }

        private static Dictionary<string, object> Object(string t, ref int i)
        {
            Dictionary<string, object> map = new Dictionary<string, object>(StringComparer.Ordinal);
            i++;
            White(t, ref i);
            if (i < t.Length && t[i] == '}') { i++; return map; }
            while (true)
            {
                White(t, ref i);
                string key = String(t, ref i);
                White(t, ref i);
                if (i >= t.Length || t[i] != ':') throw new FormatException("expected ':' at offset " + i.ToString(CultureInfo.InvariantCulture));
                i++;
                map[key] = Value(t, ref i);
                White(t, ref i);
                if (i >= t.Length) throw new FormatException("unterminated JSON object");
                if (t[i] == ',') { i++; continue; }
                if (t[i] == '}') { i++; return map; }
                throw new FormatException("expected ',' or '}' at offset " + i.ToString(CultureInfo.InvariantCulture));
            }
        }

        private static List<object> Array(string t, ref int i)
        {
            List<object> list = new List<object>();
            i++;
            White(t, ref i);
            if (i < t.Length && t[i] == ']') { i++; return list; }
            while (true)
            {
                list.Add(Value(t, ref i));
                White(t, ref i);
                if (i >= t.Length) throw new FormatException("unterminated JSON array");
                if (t[i] == ',') { i++; continue; }
                if (t[i] == ']') { i++; return list; }
                throw new FormatException("expected ',' or ']' at offset " + i.ToString(CultureInfo.InvariantCulture));
            }
        }

        private static string String(string t, ref int i)
        {
            if (i >= t.Length || t[i] != '"') throw new FormatException("expected a string at offset " + i.ToString(CultureInfo.InvariantCulture));
            i++;
            StringBuilder sb = new StringBuilder(32);
            while (true)
            {
                if (i >= t.Length) throw new FormatException("unterminated JSON string");
                char ch = t[i++];
                if (ch == '"') return sb.ToString();
                if (ch != '\\') { sb.Append(ch); continue; }
                if (i >= t.Length) throw new FormatException("unterminated escape");
                char esc = t[i++];
                switch (esc)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u':
                        if (i + 4 > t.Length) throw new FormatException("truncated \\u escape");
                        int cp = int.Parse(t.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                        i += 4;
                        if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 <= t.Length && t[i] == '\\' && t[i + 1] == 'u')
                        {
                            int low = int.Parse(t.Substring(i + 2, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                            if (low >= 0xDC00 && low <= 0xDFFF) { sb.Append((char)cp); sb.Append((char)low); i += 6; break; }
                        }
                        sb.Append((char)cp);
                        break;
                    default: throw new FormatException("bad escape \\" + esc);
                }
            }
        }

        private static object Number(string t, ref int i)
        {
            int start = i;
            if (i < t.Length && (t[i] == '-' || t[i] == '+')) i++;
            bool floating = false;
            while (i < t.Length)
            {
                char ch = t[i];
                if (ch >= '0' && ch <= '9') { i++; continue; }
                if (ch == '.' || ch == 'e' || ch == 'E' || ch == '-' || ch == '+') { floating = floating || ch == '.' || ch == 'e' || ch == 'E'; i++; continue; }
                break;
            }
            string raw = t.Substring(start, i - start);
            if (raw.Length == 0) throw new FormatException("expected a number at offset " + start.ToString(CultureInfo.InvariantCulture));
            if (!floating)
            {
                long l;
                if (long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out l)) return l;
            }
            return double.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture);
        }
    }

    // Ordered request bodies: the hub rejects unknown keys (onlyKeys) and treats
    // an absent `consent` differently from `consent:false`, so key order and key
    // omission both have to survive serialisation.
    internal sealed class Body
    {
        private readonly List<KeyValuePair<string, object>> items = new List<KeyValuePair<string, object>>(6);

        internal Body Set(string key, object value)
        {
            items.Add(new KeyValuePair<string, object>(key, value));
            return this;
        }

        internal string ToJson() { return Json.Write(items); }
    }

    internal static class J
    {
        internal static Dictionary<string, object> AsObject(object value) { return value as Dictionary<string, object>; }

        internal static Dictionary<string, object> O(Dictionary<string, object> o, string key)
        {
            object v;
            if (o != null && o.TryGetValue(key, out v)) return v as Dictionary<string, object>;
            return null;
        }

        internal static List<object> A(Dictionary<string, object> o, string key)
        {
            object v;
            if (o != null && o.TryGetValue(key, out v)) return v as List<object>;
            return null;
        }

        internal static string S(Dictionary<string, object> o, string key)
        {
            object v;
            if (o != null && o.TryGetValue(key, out v) && v is string) return (string)v;
            return null;
        }

        internal static bool Has(Dictionary<string, object> o, string key)
        {
            object v;
            return o != null && o.TryGetValue(key, out v);
        }

        internal static long N(Dictionary<string, object> o, string key)
        {
            object v;
            if (o != null && o.TryGetValue(key, out v))
            {
                if (v is long) return (long)v;
                if (v is double) return (long)(double)v;
            }
            return 0;
        }

        internal static bool B(Dictionary<string, object> o, string key)
        {
            object v;
            if (o != null && o.TryGetValue(key, out v) && v is bool) return (bool)v;
            return false;
        }

        internal static string Stamp(long epochMs)
        {
            if (epochMs <= 0) return "-";
            return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(epochMs).ToLocalTime()
                .ToString("MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
        }
    }

    internal sealed class HubResponse
    {
        internal int Status;
        internal string Code;
        internal string Message;
        internal object Body;
        internal string RawBody;
        internal bool TransportFailed;
        internal bool ParseFailed;

        internal bool Ok { get { return !TransportFailed && !ParseFailed && Status >= 200 && Status < 300; } }

        internal Dictionary<string, object> Object { get { return J.AsObject(Body); } }

        // One line for the status bar: never the raw body, never the token.
        internal string Summary()
        {
            if (TransportFailed) return "hub unreachable: " + Redact.Scrub(Message);
            if (ParseFailed) return "hub replied with non-JSON (" + Status.ToString(CultureInfo.InvariantCulture) + ")";
            if (Ok) return "HTTP " + Status.ToString(CultureInfo.InvariantCulture);
            return "HTTP " + Status.ToString(CultureInfo.InvariantCulture) + " " + (Code ?? "") + ": " + Redact.Scrub(Message);
        }
    }

    internal static class Hub
    {
        internal static HubResponse Request(Config cfg, string method, string resource, string bodyJson)
        {
            HubResponse result = new HubResponse();
            HttpWebRequest req;
            try
            {
                req = (HttpWebRequest)WebRequest.Create(cfg.Url + resource);
            }
            catch (Exception ex)
            {
                result.TransportFailed = true;
                result.Code = "BAD_URL";
                result.Message = ex.Message;
                return result;
            }
            req.Method = method;
            req.Accept = "application/json";
            req.Timeout = cfg.TimeoutMs;
            req.ReadWriteTimeout = cfg.TimeoutMs;
            req.KeepAlive = true;
            req.Headers[HttpRequestHeader.Authorization] = "Bearer " + cfg.Token;
            if (bodyJson != null)
            {
                byte[] payload = Encoding.UTF8.GetBytes(bodyJson);
                req.ContentType = "application/json";
                req.ContentLength = payload.Length;
                try
                {
                    using (Stream s = req.GetRequestStream()) s.Write(payload, 0, payload.Length);
                }
                catch (Exception ex)
                {
                    result.TransportFailed = true;
                    result.Code = "TRANSPORT";
                    result.Message = ex.Message;
                    return result;
                }
            }
            HttpWebResponse resp = null;
            try
            {
                resp = (HttpWebResponse)req.GetResponse();
            }
            catch (WebException we)
            {
                resp = we.Response as HttpWebResponse;
                if (resp == null)
                {
                    result.TransportFailed = true;
                    result.Code = "TRANSPORT";
                    result.Message = we.Status == WebExceptionStatus.Timeout ? "timed out after "
                        + cfg.TimeoutMs.ToString(CultureInfo.InvariantCulture) + "ms" : we.Message;
                    return result;
                }
            }
            catch (Exception ex)
            {
                result.TransportFailed = true;
                result.Code = "TRANSPORT";
                result.Message = ex.Message;
                return result;
            }
            using (resp)
            {
                result.Status = (int)resp.StatusCode;
                string text;
                try
                {
                    using (Stream rs = resp.GetResponseStream())
                    using (StreamReader reader = new StreamReader(rs, Encoding.UTF8))
                        text = reader.ReadToEnd();
                }
                catch (Exception ex)
                {
                    result.TransportFailed = true;
                    result.Code = "TRANSPORT";
                    result.Message = ex.Message;
                    return result;
                }
                if (text.Length > 524288) text = text.Substring(0, 524288);
                result.RawBody = text;
                if (text.Length > 0)
                {
                    try { result.Body = Json.Parse(text); }
                    catch (Exception ex) { result.ParseFailed = true; result.Code = "BAD_JSON"; result.Message = ex.Message; }
                }
                if (result.Status >= 400 && !result.ParseFailed)
                {
                    // Hub faults are { error: { code, message, retryAfterMs? } }.
                    Dictionary<string, object> err = J.O(result.Object, "error");
                    if (err != null)
                    {
                        result.Code = J.S(err, "code");
                        result.Message = J.S(err, "message");
                    }
                }
                if (result.Status >= 400 && string.IsNullOrEmpty(result.Code))
                {
                    result.Code = "HTTP_" + result.Status.ToString(CultureInfo.InvariantCulture);
                    result.Message = "hub returned " + result.Status.ToString(CultureInfo.InvariantCulture) + " without a fault body";
                }
                return result;
            }
        }
    }

    internal sealed class NodeRow
    {
        internal string Id = "";
        internal bool Online;
        internal long LastSeen;
        internal string Targets = "";
        internal string Fingerprint = "";
        internal string Security = "";
        internal string Source = "";
        internal long RegisteredAt;
    }

    internal sealed class NodesPayload
    {
        internal List<NodeRow> Nodes = new List<NodeRow>();
        internal long QueueTtlMs;
        internal long NodeQueueLimit;
        internal string StoreAcl = "";
        internal string StorePaths = "";
    }

    internal sealed class MessageRow
    {
        internal string Id = "";
        internal string To = "";
        internal string Target = "";
        internal string Text = "";
        internal string Mode = "";
        internal string Status = "";
        internal long CreatedAt;
        internal long UpdatedAt;
        internal bool Consent;
        internal long Attempts;
        internal long Deferrals;
        internal bool Deferred;
        internal bool Retryable;
        internal long Retries;
        // Only meaningful when the hub actually sent the field: an older hub has
        // no retryEligible, and guessing "absent means false" would grey out
        // every row that could still be retried.
        internal bool RetryEligibleKnown;
        internal bool RetryEligible;
        internal bool Terminal;
        internal long ExpiresAt;
        internal bool EverUncertain;
        internal string Settlement = "";
        internal long UncertainAt;
        internal long UncertainDeadline;
        internal string ErrorCode = "";
        internal string ErrorMessage = "";
        internal string ResultText = "";
        internal string ClaimId = "";
    }

    internal sealed class Client
    {
        private readonly Config cfg;

        internal Client(Config cfg)
        {
            this.cfg = cfg;
            Redact.SetSecret(cfg.Token);
        }

        internal HubResponse GetNodes(out NodesPayload payload)
        {
            payload = null;
            HubResponse r = Hub.Request(cfg, "GET", "/nodes", null);
            if (!r.Ok) return r;
            Dictionary<string, object> root = r.Object;
            if (root == null) { r.ParseFailed = true; r.Code = "BAD_SHAPE"; r.Message = "/nodes did not return a JSON object"; return r; }
            NodesPayload p = new NodesPayload();
            p.QueueTtlMs = J.N(root, "queueTtlMs");
            p.NodeQueueLimit = J.N(root, "nodeQueueLimit");
            Dictionary<string, object> store = J.O(root, "store");
            if (store != null)
            {
                p.StoreAcl = J.S(store, "acl") ?? "";
                List<object> paths = J.A(store, "paths");
                if (paths != null)
                {
                    StringBuilder sb = new StringBuilder();
                    foreach (object item in paths)
                    {
                        Dictionary<string, object> entry = J.AsObject(item);
                        if (entry == null) continue;
                        if (sb.Length > 0) sb.Append("; ");
                        sb.Append(J.S(entry, "path") ?? "?").Append(" acl=").Append(J.S(entry, "acl") ?? "?");
                    }
                    p.StorePaths = sb.ToString();
                }
            }
            List<object> nodes = J.A(root, "nodes");
            if (nodes != null)
            {
                foreach (object item in nodes)
                {
                    Dictionary<string, object> n = J.AsObject(item);
                    if (n == null) continue;
                    NodeRow row = new NodeRow();
                    row.Id = J.S(n, "id") ?? "";
                    row.Online = J.B(n, "online");
                    row.LastSeen = J.N(n, "lastSeen");
                    row.RegisteredAt = J.N(n, "registeredAt");
                    row.Source = J.S(n, "heartbeatSource") ?? "";
                    List<object> targets = J.A(n, "targets");
                    if (targets != null)
                    {
                        StringBuilder sb = new StringBuilder();
                        foreach (object t in targets)
                        {
                            if (sb.Length > 0) sb.Append(",");
                            sb.Append(Convert.ToString(t, CultureInfo.InvariantCulture));
                        }
                        row.Targets = sb.ToString();
                    }
                    Dictionary<string, object> cred = J.O(n, "credential");
                    if (cred != null) row.Fingerprint = J.S(cred, "fingerprint") ?? "";
                    Dictionary<string, object> security = J.O(n, "security");
                    if (security != null)
                    {
                        StringBuilder sb = new StringBuilder();
                        foreach (KeyValuePair<string, object> kv in security)
                        {
                            Dictionary<string, object> entry = J.AsObject(kv.Value);
                            long count = J.N(entry, "count");
                            if (count <= 0) continue;
                            if (sb.Length > 0) sb.Append(" ");
                            sb.Append(kv.Key).Append(" x").Append(count.ToString(CultureInfo.InvariantCulture));
                        }
                        row.Security = sb.Length == 0 ? "clean" : sb.ToString();
                    }
                    p.Nodes.Add(row);
                }
            }
            payload = p;
            return r;
        }

        // GET /messages is the hub's node-claim poll: it needs a node credential
        // plus ?to=&sessionId=, so an operator credential cannot use it as a
        // fleet-wide listing today. The probe stays in place so the grid starts
        // working the moment the hub grows an admin listing, and until then it
        // reports honestly instead of showing an empty table.
        internal HubResponse ProbeListing(out List<string> ids, out string note)
        {
            ids = new List<string>();
            note = null;
            HubResponse r = Hub.Request(cfg, "GET", "/messages", null);
            if (r.TransportFailed)
            {
                note = "listing probe failed: " + Redact.Scrub(r.Message);
                return r;
            }
            if (!r.Ok)
            {
                note = "no operator listing on this hub (GET /messages -> "
                    + r.Status.ToString(CultureInfo.InvariantCulture) + " " + (r.Code ?? "")
                    + "); the grid shows ids this client knows and reads each with GET /messages/:id";
                return r;
            }
            List<object> array = null;
            Dictionary<string, object> root = r.Object;
            if (root != null)
            {
                array = J.A(root, "messages");
                if (array == null && J.Has(root, "message"))
                {
                    // The node-claim shape: { message: <row|null> }. Not a listing,
                    // but a claimed row is still a real id worth showing.
                    array = new List<object>();
                    Dictionary<string, object> single = J.O(root, "message");
                    if (single != null) array.Add(single);
                    else note = "hub answered with the node-claim shape (message:null), not an operator listing";
                }
            }
            else
            {
                array = r.Body as List<object>;
            }
            if (array == null)
            {
                note = "hub listing has an unrecognised shape";
                return r;
            }
            foreach (object item in array)
            {
                Dictionary<string, object> row = J.AsObject(item);
                string id = row == null ? null : J.S(row, "id");
                if (!string.IsNullOrEmpty(id) && !ids.Contains(id)) ids.Add(id);
            }
            if (note == null)
            {
                note = "hub listing in use (" + ids.Count.ToString(CultureInfo.InvariantCulture) + " ids)";
            }
            return r;
        }

        internal HubResponse GetMessage(string id, out MessageRow row)
        {
            row = null;
            HubResponse r = Hub.Request(cfg, "GET", "/messages/" + Uri.EscapeDataString(id), null);
            if (!r.Ok) return r;
            row = ParseMessage(r.Object);
            if (row == null) { r.ParseFailed = true; r.Code = "BAD_SHAPE"; r.Message = "/messages/" + id + " is not a message object"; }
            return r;
        }

        internal HubResponse Send(string to, string target, string text, bool consentGiven, out MessageRow row)
        {
            row = null;
            Body body = new Body().Set("to", to).Set("target", target).Set("text", text);
            // Unchecked means the key is absent, exactly like the CLI and MCP
            // paths: `consent:false` is a recorded denial, silence is not.
            if (consentGiven) body.Set("consent", true);
            HubResponse r = Hub.Request(cfg, "POST", "/messages", body.ToJson());
            if (!r.Ok) return r;
            row = ParseMessage(r.Object);
            return r;
        }

        internal HubResponse Retry(string id)
        {
            return Hub.Request(cfg, "POST", "/messages/" + Uri.EscapeDataString(id) + "/retry", new Body().ToJson());
        }

        internal static MessageRow ParseMessage(Dictionary<string, object> m)
        {
            if (m == null) return null;
            MessageRow row = new MessageRow();
            row.Id = J.S(m, "id") ?? "";
            row.To = J.S(m, "to") ?? "";
            row.Target = J.S(m, "target") ?? "";
            row.Text = J.S(m, "text") ?? "";
            row.Mode = J.S(m, "mode") ?? "";
            row.Status = J.S(m, "status") ?? "";
            row.CreatedAt = J.N(m, "createdAt");
            row.UpdatedAt = J.N(m, "updatedAt");
            row.Consent = J.B(m, "consent");
            row.Attempts = J.N(m, "attempts");
            row.Deferrals = J.N(m, "deferrals");
            row.Deferred = J.B(m, "deferred");
            row.Retryable = J.B(m, "retryable");
            row.Retries = J.N(m, "retries");
            row.RetryEligibleKnown = J.Has(m, "retryEligible");
            row.RetryEligible = J.B(m, "retryEligible");
            row.Terminal = J.B(m, "terminal");
            row.ExpiresAt = J.N(m, "expiresAt");
            row.EverUncertain = J.B(m, "everUncertain");
            row.Settlement = J.S(m, "settlement") ?? "";
            row.UncertainAt = J.N(m, "uncertainAt");
            row.UncertainDeadline = J.N(m, "uncertainDeadline");
            row.ClaimId = J.S(m, "claimId") ?? "";
            Dictionary<string, object> err = J.O(m, "error");
            if (err != null)
            {
                row.ErrorCode = J.S(err, "code") ?? "";
                row.ErrorMessage = J.S(err, "message") ?? "";
            }
            object result = null;
            if (m.TryGetValue("result", out result) && result != null) row.ResultText = Json.Write(result);
            return row;
        }
    }

    // The retry contract as the hub implements it (lib/distributed.js):
    // POST /messages/:id/retry is admin-only, accepts a row whose status is in
    // RETRYABLE_FROM = {queued, deferred, expired, failed}, and refuses
    // delivering (CLAIM_ACTIVE), uncertain (UNCERTAIN_NOT_RETRYABLE) and
    // delivered (ALREADY_SETTLED) with 409. A retry re-queues the row: the
    // deferral budget and the TTL clock reset, while attempts, retries+1,
    // consent, the sticky uncertain marker and the settlement trail are kept.
    internal static class RetryRules
    {
        internal const string OkKind = "ok";
        internal const string EndpointMissing = "endpoint-missing";
        internal const string State = "state-not-allowed";
        internal const string Credential = "insufficient-credential";
        internal const string NotFound = "message-not-found";
        internal const string QueueFull = "queue-full";
        internal const string BadId = "bad-message-id";
        internal const string Transport = "hub-unreachable";
        internal const string Error = "error";

        // The hub publishes retryEligible, so that decides the button; the status
        // list is only the fallback for a hub old enough not to send it. Rows the
        // hub will refuse are greyed out instead of failing on click.
        internal static bool IsRetryableRow(MessageRow row)
        {
            if (row == null) return false;
            if (row.RetryEligibleKnown) return row.RetryEligible;
            string s = row.Status;
            return s == "queued" || s == "deferred" || s == "expired" || s == "failed";
        }

        internal static string Verdict(HubResponse r, out string text)
        {
            if (r.TransportFailed) { text = "hub unreachable: " + Redact.Scrub(r.Message); return Transport; }
            if (r.Ok)
            {
                Dictionary<string, object> o = r.Object;
                string status = J.S(o, "status");
                text = "retry accepted: re-queued as " + (status ?? "?")
                    + " (attempts=" + J.N(o, "attempts").ToString(CultureInfo.InvariantCulture)
                    + ", deferrals=" + J.N(o, "deferrals").ToString(CultureInfo.InvariantCulture)
                    + ", retries=" + J.N(o, "retries").ToString(CultureInfo.InvariantCulture)
                    + ", expiresAt=" + J.Stamp(J.N(o, "expiresAt")) + ")";
                return OkKind;
            }
            string detail = (r.Code ?? "") + " " + Redact.Scrub(r.Message ?? "");
            switch (r.Status)
            {
                case 400:
                    text = "hub rejected the message id (" + detail.Trim() + ")";
                    return BadId;
                case 401:
                case 403:
                    text = "credential is not allowed to retry - this route needs the hub bootstrap credential (" + detail.Trim() + ")";
                    return Credential;
                case 404:
                    if (r.Code == "NOT_FOUND" && (r.Message ?? "").IndexOf("Route not found", StringComparison.Ordinal) >= 0)
                    {
                        text = "endpoint not deployed: this hub has no POST /messages/:id/retry (" + detail.Trim() + ")";
                        return EndpointMissing;
                    }
                    text = "message not found by the hub (" + detail.Trim() + ")";
                    return NotFound;
                case 409:
                    text = "state does not allow a retry (" + detail.Trim() + ")";
                    return State;
                case 429:
                    text = "retry refused, the destination queue is full (" + detail.Trim() + ")";
                    return QueueFull;
                default:
                    text = "retry refused: HTTP " + r.Status.ToString(CultureInfo.InvariantCulture) + " " + detail.Trim();
                    return Error;
            }
        }
    }

    // Ids this client has seen. The hub exposes no operator-wide listing, so a
    // restart would otherwise forget every message the operator sent from here.
    // Only ids are stored - no text, no token.
    internal sealed class KnownIds
    {
        private const int Cap = 400;
        private readonly List<string> ids = new List<string>();
        private readonly Dictionary<string, bool> seen = new Dictionary<string, bool>(StringComparer.Ordinal);
        private readonly string path;
        internal string LastError;

        internal KnownIds(string home)
        {
            path = Path.Combine(home, "desktop-known-messages.json");
        }

        internal void Load()
        {
            try
            {
                if (!File.Exists(path)) return;
                List<object> list = Json.Parse(File.ReadAllText(path, Encoding.UTF8)) as List<object>;
                if (list == null) return;
                foreach (object item in list)
                {
                    string id = item as string;
                    if (!string.IsNullOrEmpty(id)) Remember(id);
                }
            }
            catch (Exception ex) { LastError = "known-id cache unreadable: " + ex.Message; }
        }

        internal bool Remember(string id)
        {
            if (string.IsNullOrEmpty(id) || seen.ContainsKey(id)) return false;
            seen[id] = true;
            ids.Add(id);
            while (ids.Count > Cap)
            {
                string oldest = ids[0];
                ids.RemoveAt(0);
                seen.Remove(oldest);
            }
            return true;
        }

        internal List<string> Snapshot() { return new List<string>(ids); }

        internal void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllText(path, Json.Write(Snapshot()), new UTF8Encoding(false));
            }
            catch (Exception ex) { LastError = "known-id cache not saved: " + ex.Message; }
        }
    }

    internal static class Win32
    {
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        // Used by --selftest to prove it never put a window on the operator's
        // desktop, and by --bench to prove the opposite for the real GUI.
        internal static int[] WindowsForCurrentProcess()
        {
            uint self = (uint)Process.GetCurrentProcess().Id;
            int[] counts = new int[2];
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid == self)
                {
                    counts[0]++;
                    if (IsWindowVisible(hWnd)) counts[1]++;
                }
                return true;
            }, IntPtr.Zero);
            return counts;
        }
    }

    internal sealed class MainForm : Form
    {
        private static readonly Color Delivered = Color.FromArgb(0, 110, 40);
        private static readonly Color Queued = Color.FromArgb(0, 60, 150);
        private static readonly Color Delivering = Color.FromArgb(0, 110, 130);
        private static readonly Color Deferred = Color.FromArgb(160, 90, 0);
        private static readonly Color Uncertain = Color.FromArgb(140, 0, 140);
        private static readonly Color Failed = Color.FromArgb(180, 0, 0);
        private static readonly Color Expired = Color.Gray;

        private readonly Config cfg;
        private readonly Client client;
        private readonly KnownIds known;

        private readonly List<NodeRow> nodes = new List<NodeRow>();
        private readonly List<MessageRow> messages = new List<MessageRow>();

        private ListView nodeView;
        private ListView msgView;
        private TextBox detailBox;
        private Label headerLabel;
        private Label statusLabel;
        private Label pauseLabel;
        private Button refreshButton;
        private Button retryButton;
        private Button sendButton;
        private CheckBox autoBox;
        private NumericUpDown intervalBox;
        private System.Windows.Forms.Timer timer;
        private TabControl tabs;
        private TextBox sendTo;
        private TextBox sendTarget;
        private TextBox sendText;
        private CheckBox sendConsent;

        private int busy;
        private int detailSeq;
        private int refreshCount;
        private string selectedNodeId;
        private string selectedMsgId;
        private string listingNote = "not probed yet";
        private bool paused;

        internal MainForm(Config config)
        {
            // Counted so --selftest can prove it never built a window: any form
            // that exists at all shows up in this tally.
            SelfTest.NoteFormCreated();
            cfg = config;
            client = new Client(cfg);
            known = new KnownIds(cfg.Home);
            known.Load();
            BuildUi();
            SetStatus("ready - " + cfg.Url + " (token " + cfg.TokenFingerprint + " from " + cfg.TokenSource + ")");
            Load += delegate { BeginRefresh(true); };
        }

        private void BuildUi()
        {
            Text = "OpenAcom Desktop";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(1000, 620);
            MinimumSize = new Size(720, 420);
            Font = new Font("Segoe UI", 9F);

            headerLabel = new Label();
            headerLabel.Dock = DockStyle.Top;
            headerLabel.Height = 64;
            headerLabel.Padding = new Padding(8, 4, 8, 0);
            headerLabel.Text = cfg.Url;

            Panel bar = new Panel();
            bar.Dock = DockStyle.Top;
            bar.Height = 38;

            refreshButton = new Button();
            refreshButton.Text = "Refresh now";
            refreshButton.SetBounds(8, 6, 96, 26);
            refreshButton.Click += delegate { BeginRefresh(true); };

            Label every = new Label();
            every.Text = "every";
            every.SetBounds(114, 11, 34, 18);

            intervalBox = new NumericUpDown();
            intervalBox.Minimum = 1;
            intervalBox.Maximum = 60;
            intervalBox.Value = Math.Max(1, Math.Min(60, cfg.IntervalSeconds));
            intervalBox.SetBounds(150, 7, 52, 24);
            intervalBox.ValueChanged += delegate { ApplyInterval(); };

            Label secs = new Label();
            secs.Text = "s";
            secs.SetBounds(205, 11, 12, 18);

            autoBox = new CheckBox();
            autoBox.Text = "auto refresh";
            autoBox.Checked = true;
            autoBox.SetBounds(224, 9, 100, 22);
            autoBox.CheckedChanged += delegate { ApplyInterval(); };

            pauseLabel = new Label();
            pauseLabel.SetBounds(332, 11, 220, 18);
            pauseLabel.ForeColor = Color.DimGray;

            bar.Controls.Add(refreshButton);
            bar.Controls.Add(every);
            bar.Controls.Add(intervalBox);
            bar.Controls.Add(secs);
            bar.Controls.Add(autoBox);
            bar.Controls.Add(pauseLabel);

            statusLabel = new Label();
            statusLabel.Dock = DockStyle.Bottom;
            statusLabel.Height = 22;
            statusLabel.Padding = new Padding(8, 3, 8, 0);
            statusLabel.BorderStyle = BorderStyle.Fixed3D;

            tabs = new TabControl();
            tabs.Dock = DockStyle.Fill;

            TabPage nodesTab = new TabPage("Nodes");
            nodeView = MakeList(new string[] { "id", "state", "last seen", "targets", "credential", "security", "heartbeat from" },
                new int[] { 150, 62, 110, 170, 90, 250, 110 });
            nodeView.RetrieveVirtualItem += NodesRetrieve;
            nodeView.SelectedIndexChanged += delegate { KeepNodeSelection(); };
            nodesTab.Controls.Add(nodeView);

            TabPage msgsTab = new TabPage("Messages");
            Panel msgBar = new Panel();
            msgBar.Dock = DockStyle.Top;
            msgBar.Height = 34;
            retryButton = new Button();
            retryButton.Text = "Retry delivery (POST /messages/:id/retry)";
            retryButton.SetBounds(8, 4, 250, 26);
            retryButton.Enabled = false;
            retryButton.Click += delegate { RetrySelected(); };
            Label retryHint = new Label();
            retryHint.SetBounds(266, 9, 700, 18);
            retryHint.ForeColor = Color.DimGray;
            retryHint.Text = "hub re-queues queued / deferred / expired / failed rows; grey when delivered, claimed or uncertain. Never automatic.";
            msgBar.Controls.Add(retryButton);
            msgBar.Controls.Add(retryHint);

            detailBox = new TextBox();
            detailBox.Multiline = true;
            detailBox.ReadOnly = true;
            detailBox.ScrollBars = ScrollBars.Vertical;
            detailBox.WordWrap = false;
            detailBox.Dock = DockStyle.Bottom;
            detailBox.Height = 150;
            detailBox.BackColor = Color.White;
            detailBox.Font = new Font("Consolas", 9F);

            msgView = MakeList(new string[] { "id", "to", "target", "status", "att", "defl", "retr", "settlement", "uncertain", "mode", "consent", "updated", "text" },
                new int[] { 78, 110, 100, 84, 34, 38, 36, 150, 68, 56, 60, 100, 240 });
            msgView.RetrieveVirtualItem += MessagesRetrieve;
            msgView.SelectedIndexChanged += delegate { MessageSelected(); };

            msgsTab.Controls.Add(msgView);
            msgsTab.Controls.Add(detailBox);
            msgsTab.Controls.Add(msgBar);
            msgView.BringToFront();

            TabPage sendTab = new TabPage("Send");
            Panel sendPanel = new Panel();
            sendPanel.Dock = DockStyle.Fill;
            sendPanel.AutoScroll = true;

            Label lTo = new Label(); lTo.Text = "to (node id)"; lTo.SetBounds(14, 16, 96, 18);
            sendTo = new TextBox(); sendTo.SetBounds(116, 13, 260, 24);
            Label lTarget = new Label(); lTarget.Text = "target"; lTarget.SetBounds(14, 46, 96, 18);
            sendTarget = new TextBox(); sendTarget.SetBounds(116, 43, 260, 24);
            sendConsent = new CheckBox();
            sendConsent.Text = "consent = true (I am authorised to submit into a desktop)";
            sendConsent.SetBounds(116, 72, 460, 22);
            Label lText = new Label(); lText.Text = "text"; lText.SetBounds(14, 104, 96, 18);
            sendText = new TextBox();
            sendText.Multiline = true;
            sendText.ScrollBars = ScrollBars.Vertical;
            sendText.AcceptsReturn = true;
            sendText.SetBounds(116, 101, 560, 150);
            sendButton = new Button();
            sendButton.Text = "Send (POST /messages)";
            sendButton.SetBounds(116, 262, 180, 28);
            sendButton.Click += delegate { SendClicked(); };
            Label sendHint = new Label();
            sendHint.SetBounds(14, 300, 700, 60);
            sendHint.ForeColor = Color.DimGray;
            sendHint.Text = "Leaving consent unchecked omits the field entirely - the hub then treats the message as not\n"
                + "authorised for a desktop submit (CONSENT_REQUIRED), which is not the same as sending false.\n"
                + "Mode is not sent either, so the hub applies its own default.";
            sendPanel.Controls.Add(lTo); sendPanel.Controls.Add(sendTo);
            sendPanel.Controls.Add(lTarget); sendPanel.Controls.Add(sendTarget);
            sendPanel.Controls.Add(sendConsent);
            sendPanel.Controls.Add(lText); sendPanel.Controls.Add(sendText);
            sendPanel.Controls.Add(sendButton); sendPanel.Controls.Add(sendHint);
            sendTab.Controls.Add(sendPanel);

            tabs.TabPages.Add(nodesTab);
            tabs.TabPages.Add(msgsTab);
            tabs.TabPages.Add(sendTab);

            Controls.Add(tabs);
            Controls.Add(bar);
            Controls.Add(headerLabel);
            Controls.Add(statusLabel);
            tabs.BringToFront();

            timer = new System.Windows.Forms.Timer();
            ApplyInterval();
            timer.Tick += delegate { BeginRefresh(false); };
            Resize += delegate { UpdatePauseState(); };
            FormClosing += delegate
            {
                if (timer != null) { timer.Stop(); timer.Dispose(); timer = null; }
                known.Save();
            };
        }

        private static ListView MakeList(string[] columns, int[] widths)
        {
            ListView list = new ListView();
            list.Dock = DockStyle.Fill;
            list.View = View.Details;
            list.FullRowSelect = true;
            list.GridLines = true;
            list.MultiSelect = false;
            list.HideSelection = false;
            list.VirtualMode = true;
            list.VirtualListSize = 0;
            for (int i = 0; i < columns.Length; i++)
            {
                ColumnHeader h = new ColumnHeader();
                h.Text = columns[i];
                h.Width = widths[i];
                list.Columns.Add(h);
            }
            return list;
        }

        private void ApplyInterval()
        {
            int seconds = (int)intervalBox.Value;
            if (timer != null)
            {
                timer.Interval = seconds * 1000;
                if (autoBox.Checked && !paused) timer.Start();
                else timer.Stop();
            }
            UpdatePauseState();
        }

        private void UpdatePauseState()
        {
            bool minimized = WindowState == FormWindowState.Minimized;
            if (minimized != paused)
            {
                paused = minimized;
                if (timer == null) return;
                if (paused) timer.Stop();
                else if (autoBox.Checked) timer.Start();
            }
            if (pauseLabel != null)
            {
                pauseLabel.Text = paused ? "paused while minimised" : (autoBox.Checked ? "" : "auto refresh off");
            }
        }

        private void SetStatus(string text)
        {
            statusLabel.Text = Redact.Scrub(text);
        }

        private void KeepNodeSelection()
        {
            if (nodeView.SelectedIndices.Count == 0) { selectedNodeId = null; return; }
            int index = nodeView.SelectedIndices[0];
            if (index >= 0 && index < nodes.Count) selectedNodeId = nodes[index].Id;
        }

        private void NodesRetrieve(object sender, RetrieveVirtualItemEventArgs e)
        {
            if (e.ItemIndex < 0 || e.ItemIndex >= nodes.Count) { e.Item = new ListViewItem(""); return; }
            NodeRow r = nodes[e.ItemIndex];
            ListViewItem item = new ListViewItem(r.Id);
            item.SubItems.Add(r.Online ? "online" : "offline");
            item.SubItems.Add(J.Stamp(r.LastSeen));
            item.SubItems.Add(r.Targets);
            item.SubItems.Add(r.Fingerprint.Length == 0 ? "-" : r.Fingerprint);
            item.SubItems.Add(r.Security);
            item.SubItems.Add(r.Source);
            item.ForeColor = r.Online ? Delivered : Expired;
            e.Item = item;
        }

        private void MessagesRetrieve(object sender, RetrieveVirtualItemEventArgs e)
        {
            if (e.ItemIndex < 0 || e.ItemIndex >= messages.Count) { e.Item = new ListViewItem(""); return; }
            MessageRow r = messages[e.ItemIndex];
            ListViewItem item = new ListViewItem(Short(r.Id));
            item.SubItems.Add(r.To);
            item.SubItems.Add(r.Target);
            item.SubItems.Add(r.Status);
            item.SubItems.Add(r.Attempts.ToString(CultureInfo.InvariantCulture));
            item.SubItems.Add(r.Deferrals.ToString(CultureInfo.InvariantCulture));
            item.SubItems.Add(r.Retries.ToString(CultureInfo.InvariantCulture));
            item.SubItems.Add(r.Settlement.Length == 0 ? "-" : r.Settlement);
            item.SubItems.Add(r.EverUncertain ? "yes" : "no");
            item.SubItems.Add(r.Mode);
            item.SubItems.Add(r.Consent ? "true" : "-");
            item.SubItems.Add(J.Stamp(r.UpdatedAt));
            item.SubItems.Add(Trim(r.Text, 90));
            item.ForeColor = StatusColor(r.Status);
            e.Item = item;
        }

        internal static Color StatusColor(string status)
        {
            switch (status)
            {
                case "delivered": return Delivered;
                case "queued": return Queued;
                case "delivering": return Delivering;
                case "deferred": return Deferred;
                case "uncertain": return Uncertain;
                case "failed": return Failed;
                case "expired": return Expired;
                default: return Color.Black;
            }
        }

        private static string Short(string id)
        {
            if (string.IsNullOrEmpty(id)) return "";
            return id.Length <= 8 ? id : id.Substring(0, 8);
        }

        private static string Trim(string text, int max)
        {
            if (text == null) return "";
            string flat = text.Replace("\r", " ").Replace("\n", " ");
            return flat.Length <= max ? flat : flat.Substring(0, max) + "...";
        }

        private MessageRow SelectedMessage()
        {
            if (msgView.SelectedIndices.Count == 0) return null;
            int index = msgView.SelectedIndices[0];
            if (index < 0 || index >= messages.Count) return null;
            return messages[index];
        }

        private void MessageSelected()
        {
            MessageRow row = SelectedMessage();
            selectedMsgId = row == null ? null : row.Id;
            retryButton.Enabled = RetryRules.IsRetryableRow(row);
            if (row == null) { detailBox.Text = ""; return; }
            detailBox.Text = Describe(row) + "\n\nfetching GET /messages/" + row.Id + " ...";
            int seq = Interlocked.Increment(ref detailSeq);
            string id = row.Id;
            ThreadPool.QueueUserWorkItem(delegate
            {
                MessageRow fresh;
                HubResponse r = client.GetMessage(id, out fresh);
                if (fresh == null) fresh = row;
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        if (seq != detailSeq || IsDisposed) return;
                        detailBox.Text = Describe(fresh) + "\n\nGET /messages/" + id + " -> " + r.Summary();
                    });
                }
                catch (ObjectDisposedException) { }
                catch (InvalidOperationException) { }
            });
        }

        private static string Describe(MessageRow m)
        {
            StringBuilder sb = new StringBuilder(512);
            sb.Append("id            ").Append(m.Id).Append('\n');
            // The hub's public message view has no `from` field; saying so beats
            // inventing a sender.
            sb.Append("from          (not exposed by the hub; only `to` is recorded)\n");
            sb.Append("to            ").Append(m.To).Append('\n');
            sb.Append("target        ").Append(m.Target).Append('\n');
            sb.Append("status        ").Append(m.Status)
                .Append(m.Terminal ? "  [terminal]" : "").Append(m.Retryable ? "  [retryable per hub]" : "").Append('\n');
            sb.Append("mode          ").Append(m.Mode).Append('\n');
            sb.Append("consent       ").Append(m.Consent ? "true" : "absent/false").Append('\n');
            sb.Append("attempts      ").Append(m.Attempts.ToString(CultureInfo.InvariantCulture))
                .Append("   deferrals ").Append(m.Deferrals.ToString(CultureInfo.InvariantCulture))
                .Append("   retries ").Append(m.Retries.ToString(CultureInfo.InvariantCulture)).Append('\n');
            sb.Append("retry         ").Append(m.RetryEligibleKnown
                ? (m.RetryEligible ? "eligible now (hub retryEligible=true)" : "refused by the hub (retryEligible=false)")
                : "hub did not report retryEligible; falling back to the status list").Append('\n');
            sb.Append("settlement    ").Append(m.Settlement.Length == 0 ? "-" : m.Settlement).Append('\n');
            sb.Append("everUncertain ").Append(m.EverUncertain ? "yes" : "no").Append('\n');
            sb.Append("created       ").Append(J.Stamp(m.CreatedAt)).Append('\n');
            sb.Append("updated       ").Append(J.Stamp(m.UpdatedAt)).Append('\n');
            sb.Append("expires       ").Append(J.Stamp(m.ExpiresAt)).Append('\n');
            if (m.UncertainAt > 0) sb.Append("uncertainAt   ").Append(J.Stamp(m.UncertainAt)).Append('\n');
            if (m.UncertainDeadline > 0) sb.Append("uncertainDue  ").Append(J.Stamp(m.UncertainDeadline)).Append('\n');
            if (m.ErrorCode.Length > 0) sb.Append("error         ").Append(m.ErrorCode).Append(": ").Append(m.ErrorMessage).Append('\n');
            if (m.ResultText.Length > 0) sb.Append("result        ").Append(m.ResultText).Append('\n');
            sb.Append("text          ").Append(m.Text);
            return sb.ToString();
        }

        private void BeginRefresh(bool manual)
        {
            if (timer == null) return;
            if (Interlocked.CompareExchange(ref busy, 1, 0) != 0)
            {
                if (manual) SetStatus("refresh already in flight - skipped");
                return;
            }
            refreshButton.Enabled = false;
            if (manual) SetStatus("refreshing " + cfg.Url + " ...");
            ThreadPool.QueueUserWorkItem(delegate { Fetch(manual); });
        }

        // Runs on a thread-pool thread: no control is touched here, so a slow or
        // dead hub can never freeze the window.
        private void Fetch(bool manual)
        {
            long started = Stopwatch.GetTimestamp();
            NodesPayload payload = null;
            HubResponse nodesResponse = client.GetNodes(out payload);
            List<string> listed = null;
            string note = null;
            HubResponse listResponse = client.ProbeListing(out listed, out note);

            List<string> ids = new List<string>();
            if (listed != null) foreach (string id in listed) if (!ids.Contains(id)) ids.Add(id);
            foreach (string id in known.Snapshot()) if (!ids.Contains(id)) ids.Add(id);

            List<MessageRow> rows = new List<MessageRow>();
            int missing = 0;
            int capped = ids.Count > 200 ? ids.Count - 200 : 0;
            for (int i = 0; i < ids.Count && i < 200; i++)
            {
                MessageRow row;
                HubResponse r = client.GetMessage(ids[i], out row);
                if (row != null) rows.Add(row);
                else if (r.Status == 404) missing++;
            }
            rows.Sort(delegate(MessageRow a, MessageRow b)
            {
                int byStatus = string.CompareOrdinal(a.Status, b.Status);
                return byStatus != 0 ? byStatus : b.UpdatedAt.CompareTo(a.UpdatedAt);
            });
            double ms = (Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency;
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    Apply(nodesResponse, payload, listResponse, note, rows, ms, manual, missing, capped);
                });
            }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
            finally { Interlocked.Exchange(ref busy, 0); }
        }

        private void Apply(HubResponse nodesResponse, NodesPayload payload, HubResponse listResponse, string note,
            List<MessageRow> rows, double ms, bool manual, int missing, int capped)
        {
            if (IsDisposed) return;
            refreshCount++;
            nodes.Clear();
            if (payload != null) nodes.AddRange(payload.Nodes);
            messages.Clear();
            messages.AddRange(rows);

            // Row-level update: the ListView controls are never rebuilt, only
            // their virtual size changes, so a refresh costs no new controls.
            nodeView.BeginUpdate();
            nodeView.VirtualListSize = nodes.Count;
            nodeView.EndUpdate();
            nodeView.Invalidate();
            msgView.BeginUpdate();
            msgView.VirtualListSize = messages.Count;
            msgView.EndUpdate();
            msgView.Invalidate();
            RestoreSelection();

            listingNote = note ?? (listResponse.Ok ? "hub listing in use" : "unavailable");
            StringBuilder head = new StringBuilder();
            head.Append(cfg.Url).Append("   token ").Append(cfg.TokenFingerprint).Append(" (").Append(cfg.TokenSource).Append(")\n");
            if (payload != null)
            {
                head.Append("store acl: ").Append(payload.StoreAcl.Length == 0 ? "?" : payload.StoreAcl)
                    .Append("   queueTtlMs: ").Append(payload.QueueTtlMs.ToString(CultureInfo.InvariantCulture))
                    .Append("   nodeQueueLimit: ").Append(payload.NodeQueueLimit.ToString(CultureInfo.InvariantCulture));
                if (payload.StorePaths.Length > 0) head.Append("\n").Append(payload.StorePaths);
            }
            head.Append("\nmessage listing: ").Append(listingNote);
            headerLabel.Text = Redact.Scrub(head.ToString());

            StringBuilder status = new StringBuilder();
            status.Append(nodesResponse.Ok
                ? "nodes " + nodes.Count.ToString(CultureInfo.InvariantCulture)
                : "nodes FAILED " + nodesResponse.Summary());
            status.Append("   messages ").Append(messages.Count.ToString(CultureInfo.InvariantCulture));
            if (missing > 0) status.Append(" (").Append(missing.ToString(CultureInfo.InvariantCulture)).Append(" ids gone)");
            if (capped > 0) status.Append(" (+").Append(capped.ToString(CultureInfo.InvariantCulture)).Append(" not fetched)");
            status.Append("   ").Append(ms.ToString("0", CultureInfo.InvariantCulture)).Append(" ms   ")
                .Append(DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture));
            if (!manual) status.Append("   auto");
            if (known.LastError != null) status.Append("   ").Append(known.LastError);
            SetStatus(status.ToString());
            refreshButton.Enabled = true;
            retryButton.Enabled = RetryRules.IsRetryableRow(SelectedMessage());
        }

        private void RestoreSelection()
        {
            if (selectedNodeId != null)
            {
                for (int i = 0; i < nodes.Count; i++)
                {
                    if (nodes[i].Id != selectedNodeId) continue;
                    nodeView.SelectedIndices.Clear();
                    nodeView.SelectedIndices.Add(i);
                    nodeView.EnsureVisible(i);
                    break;
                }
            }
            if (selectedMsgId != null)
            {
                for (int i = 0; i < messages.Count; i++)
                {
                    if (messages[i].Id != selectedMsgId) continue;
                    msgView.SelectedIndices.Clear();
                    msgView.SelectedIndices.Add(i);
                    break;
                }
            }
        }

        private void SendClicked()
        {
            string to = (sendTo.Text ?? "").Trim();
            string target = (sendTarget.Text ?? "").Trim();
            string text = sendText.Text ?? "";
            if (!IsIdentifier(to) || !IsIdentifier(target))
            {
                SetStatus("send blocked: to/target must be 1-64 chars of [A-Za-z0-9_.-] starting with a letter or digit");
                return;
            }
            if (text.Trim().Length == 0)
            {
                SetStatus("send blocked: text must not be empty");
                return;
            }
            if (Encoding.UTF8.GetByteCount(text) > 65536)
            {
                SetStatus("send blocked: text exceeds the hub's 64 KiB limit");
                return;
            }
            if (Regex.IsMatch(text, @"[\x00-\x09\x0b-\x1f\x7f-\x9f]"))
            {
                SetStatus("send blocked: text contains terminal control characters the hub rejects");
                return;
            }
            sendButton.Enabled = false;
            bool consent = sendConsent.Checked;
            SetStatus("sending POST /messages ...");
            ThreadPool.QueueUserWorkItem(delegate
            {
                MessageRow row;
                HubResponse r = client.Send(to, target, text, consent, out row);
                if (row != null) known.Remember(row.Id);
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        sendButton.Enabled = true;
                        if (row != null)
                        {
                            SetStatus("sent: id " + row.Id + " status " + row.Status + " (" + r.Summary() + ")");
                            known.Save();
                            BeginRefresh(true);
                        }
                        else
                        {
                            SetStatus("send refused: " + r.Summary());
                        }
                    });
                }
                catch (ObjectDisposedException) { }
                catch (InvalidOperationException) { }
            });
        }

        private static bool IsIdentifier(string value)
        {
            return !string.IsNullOrEmpty(value) && Regex.IsMatch(value, @"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$");
        }

        private void RetrySelected()
        {
            MessageRow row = SelectedMessage();
            if (row == null) { SetStatus("retry needs a selected message row"); return; }
            if (!RetryRules.IsRetryableRow(row))
            {
                SetStatus("retry not offered for status " + row.Status + " (already delivered, or settled)");
                return;
            }
            retryButton.Enabled = false;
            string id = row.Id;
            SetStatus("retrying " + id + " ...");
            ThreadPool.QueueUserWorkItem(delegate
            {
                HubResponse r = client.Retry(id);
                string text;
                string kind = RetryRules.Verdict(r, out text);
                try
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        // A refusal is surfaced with its kind, never swallowed.
                        SetStatus("retry [" + kind + "] " + text);
                        detailBox.Text = "POST /messages/" + id + "/retry\n-> " + kind + "\n-> " + text
                            + "\n\n" + Describe(row);
                        BeginRefresh(true);
                    });
                }
                catch (ObjectDisposedException) { }
                catch (InvalidOperationException) { }
            });
        }

        // Renders each page to a PNG by asking the form to draw itself, so the
        // layout can be checked without capturing anything else on the desktop.
        internal string CaptureTabs(string prefix)
        {
            StringBuilder note = new StringBuilder();
            int selected = tabs.SelectedIndex;
            try
            {
                for (int i = 0; i < tabs.TabPages.Count; i++)
                {
                    tabs.SelectedIndex = i;
                    Application.DoEvents();
                    using (Bitmap bmp = new Bitmap(Width, Height))
                    {
                        DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
                        string file = prefix + "-" + i.ToString(CultureInfo.InvariantCulture) + ".png";
                        bmp.Save(file, System.Drawing.Imaging.ImageFormat.Png);
                        if (note.Length > 0) note.Append("; ");
                        note.Append(tabs.TabPages[i].Text).Append(" -> ").Append(file);
                    }
                }
            }
            catch (Exception ex)
            {
                if (note.Length > 0) note.Append("; ");
                note.Append("capture failed: ").Append(ex.Message);
            }
            tabs.SelectedIndex = selected;
            return note.ToString();
        }

        // --bench drives one refresh on the UI thread so startup and steady-state
        // memory can be measured without leaving a window on the desktop.
        internal void RefreshOnceSync()
        {
            NodesPayload payload;
            HubResponse nodesResponse = client.GetNodes(out payload);
            List<string> listed;
            string note;
            HubResponse listResponse = client.ProbeListing(out listed, out note);
            List<MessageRow> rows = new List<MessageRow>();
            List<string> ids = new List<string>();
            if (listed != null) ids.AddRange(listed);
            foreach (string id in known.Snapshot()) if (!ids.Contains(id)) ids.Add(id);
            for (int i = 0; i < ids.Count && i < 200; i++)
            {
                MessageRow row;
                client.GetMessage(ids[i], out row);
                if (row != null) rows.Add(row);
            }
            Apply(nodesResponse, payload, listResponse, note, rows, 0, true, 0, 0);
        }

        internal int NodeCount { get { return nodes.Count; } }

        internal int MessageCount { get { return messages.Count; } }

        // Observed by --bench so the pause-on-minimise rule and the timer
        // disposal are proven by measurement rather than by eyeballing a window.
        internal bool AutoRefreshRunning { get { return timer != null && timer.Enabled; } }

        internal int RefreshCount { get { return refreshCount; } }

        protected override void Dispose(bool disposing)
        {
            if (disposing && timer != null)
            {
                timer.Stop();
                timer.Dispose();
                timer = null;
            }
            base.Dispose(disposing);
        }
    }

    internal static class Bench
    {
        internal static int Run(Config cfg, Options opts)
        {
            MainForm form = new MainForm(cfg);
            form.RefreshOnceSync();
            form.Show();
            Application.DoEvents();
            double startupMs = Program.Elapsed.Elapsed.TotalMilliseconds;
            Process self = Process.GetCurrentProcess();
            self.Refresh();
            long pbPaint = self.PrivateMemorySize64;
            long wsPaint = self.WorkingSet64;
            int hold = opts.HoldMs;
            DateTime until = DateTime.UtcNow.AddMilliseconds(hold);
            while (DateTime.UtcNow < until)
            {
                Application.DoEvents();
                Thread.Sleep(40);
            }
            self.Refresh();
            long pbIdle = self.PrivateMemorySize64;
            long wsIdle = self.WorkingSet64;
            long gcBytes = GC.GetTotalMemory(false);
            int refreshesDuringHold = form.RefreshCount;
            bool timerRunningBeforeMinimise = form.AutoRefreshRunning;
            // Captured after the memory samples so the bitmap cost cannot inflate
            // the numbers that the 60MB bar is judged against.
            string shot = string.IsNullOrEmpty(opts.ShotPath) ? "not requested" : form.CaptureTabs(opts.ShotPath);

            // Feature check that would otherwise need a human watching the window:
            // minimising must stop the polling timer, restoring must restart it.
            form.WindowState = FormWindowState.Minimized;
            Application.DoEvents();
            bool timerStoppedWhenMinimised = !form.AutoRefreshRunning;
            form.WindowState = FormWindowState.Normal;
            Application.DoEvents();
            bool timerResumedWhenRestored = form.AutoRefreshRunning;

            int[] windows = Win32.WindowsForCurrentProcess();
            form.Close();
            form.Dispose();
            // A timer left running after close would keep the process polling the
            // hub with no window to show it in.
            bool timerGoneAfterClose = !form.AutoRefreshRunning;
            string report = "{\n"
                + "  \"mode\": \"bench\",\n"
                + "  \"url\": " + Json.Quote(cfg.Url) + ",\n"
                + "  \"tokenFingerprint\": " + Json.Quote(cfg.TokenFingerprint) + ",\n"
                + "  \"startupMsToFirstPaint\": " + F(startupMs) + ",\n"
                + "  \"privateBytesAtFirstPaint\": " + pbPaint.ToString(CultureInfo.InvariantCulture) + ",\n"
                + "  \"workingSetAtFirstPaint\": " + wsPaint.ToString(CultureInfo.InvariantCulture) + ",\n"
                + "  \"holdMs\": " + hold.ToString(CultureInfo.InvariantCulture) + ",\n"
                + "  \"privateBytesIdle\": " + pbIdle.ToString(CultureInfo.InvariantCulture) + ",\n"
                + "  \"workingSetIdle\": " + wsIdle.ToString(CultureInfo.InvariantCulture) + ",\n"
                + "  \"managedHeapBytes\": " + gcBytes.ToString(CultureInfo.InvariantCulture) + ",\n"
                + "  \"privateBytesIdleMB\": " + F(pbIdle / 1048576.0) + ",\n"
                + "  \"nodeRows\": " + form.NodeCount.ToString(CultureInfo.InvariantCulture) + ",\n"
                + "  \"messageRows\": " + form.MessageCount.ToString(CultureInfo.InvariantCulture) + ",\n"
                + "  \"refreshesCompleted\": " + refreshesDuringHold.ToString(CultureInfo.InvariantCulture) + ",\n"
                + "  \"timerRunningBeforeMinimise\": " + B(timerRunningBeforeMinimise) + ",\n"
                + "  \"timerStoppedWhenMinimised\": " + B(timerStoppedWhenMinimised) + ",\n"
                + "  \"timerResumedWhenRestored\": " + B(timerResumedWhenRestored) + ",\n"
                + "  \"timerGoneAfterClose\": " + B(timerGoneAfterClose) + ",\n"
                + "  \"screenshot\": " + Json.Quote(Redact.Scrub(shot)) + ",\n"
                + "  \"windowsForPid\": " + windows[0].ToString(CultureInfo.InvariantCulture) + ",\n"
                + "  \"visibleWindowsForPid\": " + windows[1].ToString(CultureInfo.InvariantCulture) + "\n}\n";
            Program.Emit(opts.OutPath, report);
            return 0;
        }

        private static string B(bool value) { return value ? "true" : "false"; }

        private static string F(double v) { return v.ToString("0.0", CultureInfo.InvariantCulture); }
    }

    // Both headless modes share this writer, including the proof that no window
    // was ever put on the operator's desktop.
    internal static class Report
    {
        internal static int Emit(string mode, Config cfg, List<string[]> steps, double elapsedMs, string outPath)
        {
            int[] windows = Win32.WindowsForCurrentProcess();
            int forms = SelfTest.FormsCreated;
            bool headless = windows[0] == 0 && windows[1] == 0 && forms == 0 && !Application.MessageLoop;
            steps.Add(new string[]
            {
                "headless-no-window", headless ? "true" : "false",
                "windowsForPid=" + windows[0].ToString(CultureInfo.InvariantCulture)
                + " visibleWindowsForPid=" + windows[1].ToString(CultureInfo.InvariantCulture)
                + " formsCreated=" + forms.ToString(CultureInfo.InvariantCulture)
                + " messageLoop=" + (Application.MessageLoop ? "true" : "false"),
            });
            bool allOk = true;
            StringBuilder sb = new StringBuilder(4096);
            sb.Append("{\n  \"mode\": ").Append(Json.Quote(mode))
                .Append(",\n  \"url\": ").Append(Json.Quote(cfg.Url))
                .Append(",\n  \"tokenFingerprint\": ").Append(Json.Quote(cfg.TokenFingerprint))
                .Append(",\n  \"tokenSource\": ").Append(Json.Quote(cfg.TokenSource))
                .Append(",\n  \"elapsedMs\": ").Append(elapsedMs.ToString("0.0", CultureInfo.InvariantCulture))
                .Append(",\n  \"windowsForPid\": ").Append(windows[0].ToString(CultureInfo.InvariantCulture))
                .Append(",\n  \"visibleWindowsForPid\": ").Append(windows[1].ToString(CultureInfo.InvariantCulture))
                .Append(",\n  \"formsCreated\": ").Append(forms.ToString(CultureInfo.InvariantCulture))
                .Append(",\n  \"steps\": [\n");
            for (int i = 0; i < steps.Count; i++)
            {
                string[] s = steps[i];
                if (s[1] != "true") allOk = false;
                sb.Append("    { \"name\": ").Append(Json.Quote(s[0]))
                    .Append(", \"ok\": ").Append(s[1])
                    .Append(", \"detail\": ").Append(Json.Quote(Redact.Scrub(s[2] ?? ""))).Append(" }");
                if (i + 1 < steps.Count) sb.Append(',');
                sb.Append('\n');
            }
            sb.Append("  ],\n  \"allOk\": ").Append(allOk ? "true" : "false").Append("\n}\n");
            Program.Emit(outPath, sb.ToString());
            return allOk ? 0 : 1;
        }
    }

    internal static class SelfTest
    {
        private static readonly List<string[]> Steps = new List<string[]>();
        private static Config sharedConfig;
        private static int createdForms;

        internal static int FormsCreated { get { return createdForms; } }

        internal static void NoteFormCreated() { createdForms++; }

        internal static int Run(Config cfg, Options opts)
        {
            sharedConfig = cfg;
            Steps.Clear();
            Client client = new Client(cfg);
            Stopwatch sw = Stopwatch.StartNew();

            JsonRoundTrip();
            ConsentOmission();
            NodesListing(client);
            ListingProbe(client);
            string sentId = SendFlow(client);
            DetailFlow(client, sentId);
            RetryFlow(client, sentId);
            AuthFlow(cfg);
            TransportFlow(cfg);
            RetryClassification();

            return Report.Emit("selftest", cfg, Steps, sw.Elapsed.TotalMilliseconds, opts.OutPath);
        }

        private static void Add(string name, bool ok, string detail)
        {
            Steps.Add(new string[] { name, ok ? "true" : "false", detail });
        }

        private static void JsonRoundTrip()
        {
            try
            {
                const string text = "{\"a\":[1,2.5,true,null,\"x\\u00e9\\n\\\"q\\\"\"],\"b\":{\"c\":-3,\"d\":1700000000000},\"e\":\"\\ud83d\\ude00\"}";
                Dictionary<string, object> root = J.AsObject(Json.Parse(text));
                List<object> a = J.A(root, "a");
                Dictionary<string, object> b = J.O(root, "b");
                string e = J.S(root, "e");
                bool ok = root != null && a != null && a.Count == 5
                    && (long)a[0] == 1 && Math.Abs((double)a[1] - 2.5) < 1e-9
                    && (bool)a[2] && a[3] == null && (string)a[4] == "x\u00e9\n\"q\""
                    && J.N(b, "c") == -3 && J.N(b, "d") == 1700000000000L
                    && e != null && e.Length == 2 && e[0] == '\ud83d';
                string written = new Body().Set("text", "line1\nline2 \"quoted\" \u4f60\u597d").ToJson();
                ok = ok && written.IndexOf("line1\\nline2 \\\"quoted\\\" \u4f60\u597d", StringComparison.Ordinal) >= 0
                    && written.IndexOf("consent", StringComparison.Ordinal) < 0;
                Add("json-parser", ok, "parsed array/object/escapes/surrogate pair; body writer escaped newline+quote and kept CJK literal: " + written);
            }
            catch (Exception ex) { Add("json-parser", false, ex.Message); }
        }

        private static void ConsentOmission()
        {
            string silent = new Body().Set("to", "n").Set("target", "t").Set("text", "hi").ToJson();
            string loud = new Body().Set("to", "n").Set("target", "t").Set("text", "hi").Set("consent", true).ToJson();
            string denied = new Body().Set("to", "n").Set("target", "t").Set("text", "hi").Set("consent", false).ToJson();
            bool ok = silent.IndexOf("consent", StringComparison.Ordinal) < 0
                && loud.IndexOf("\"consent\":true", StringComparison.Ordinal) >= 0
                && denied.IndexOf("\"consent\":false", StringComparison.Ordinal) >= 0;
            Add("body-consent-semantics", ok, "unchecked=" + silent + " | checked=" + loud + " | explicit-false=" + denied);
        }

        private static void NodesListing(Client client)
        {
            try
            {
                NodesPayload payload;
                HubResponse r = client.GetNodes(out payload);
                bool ok = r.Ok && payload != null && payload.Nodes.Count > 0;
                string detail = r.Summary();
                if (payload != null && payload.Nodes.Count > 0)
                {
                    NodeRow n = payload.Nodes[0];
                    ok = ok && n.Id.Length > 0 && n.Fingerprint.Length == 8 && payload.StoreAcl.Length > 0;
                    detail += " | first=" + n.Id + " online=" + n.Online + " lastSeen=" + J.Stamp(n.LastSeen)
                        + " fingerprint=" + n.Fingerprint + " security=" + n.Security + " storeAcl=" + payload.StoreAcl
                        + " targets=" + n.Targets;
                }
                Add("nodes-list", ok, detail);
            }
            catch (Exception ex) { Add("nodes-list", false, ex.Message); }
        }

        private static void ListingProbe(Client client)
        {
            try
            {
                List<string> ids;
                string note;
                HubResponse r = client.ProbeListing(out ids, out note);
                // Either the hub grows an operator listing (ids found, no throw)
                // or it refuses - and then the client must say why, not show an
                // empty grid as if there were nothing to deliver.
                bool ok = ids != null && note != null;
                Add("listing-probe", ok, "ids=" + ids.Count + " note=" + note + " http=" + r.Status + " code=" + (r.Code ?? "-"));
            }
            catch (Exception ex) { Add("listing-probe", false, "threw instead of reporting: " + ex.Message); }
        }

        private static string SendFlow(Client client)
        {
            string id = null;
            try
            {
                MessageRow row;
                HubResponse r = client.Send("stub-node", "coder", "hello from selftest\nsecond line", false, out row);
                bool ok = r.Ok && row != null && row.Status == "queued" && row.To == "stub-node"
                    && row.Target == "coder" && !row.Consent && !string.IsNullOrEmpty(row.Id);
                Add("send-without-consent", ok, r.Summary() + " | id=" + (row == null ? "?" : row.Id)
                    + " status=" + (row == null ? "?" : row.Status) + " consent=" + (row != null && row.Consent ? "true" : "absent"));
                if (row != null) id = row.Id;

                string consentedId = Guid.NewGuid().ToString();
                HubResponse r2 = Hub.Request(sharedConfig, "POST", "/messages",
                    new Body().Set("id", consentedId).Set("to", "stub-node").Set("target", "coder")
                        .Set("text", "consented").Set("consent", true).ToJson());
                MessageRow row2 = Client.ParseMessage(r2.Object);
                Add("send-with-consent", r2.Ok && row2 != null && row2.Consent,
                    r2.Summary() + " | id=" + consentedId + " consent=" + (row2 != null && row2.Consent ? "true" : "false"));

                // The stub records every request body verbatim, so the wire form of
                // "unchecked consent" is checked on the bytes that left the process.
                HubResponse bodies = Hub.Request(sharedConfig, "GET", "/__bodies", null);
                List<object> recorded = J.A(bodies.Object, "bodies");
                bool sawSilent = false;
                bool sawLoud = false;
                int seen = 0;
                if (recorded != null)
                {
                    foreach (object item in recorded)
                    {
                        Dictionary<string, object> entry = J.AsObject(item);
                        if (entry == null) continue;
                        string path = J.S(entry, "path") ?? "";
                        string body = J.S(entry, "body") ?? "";
                        if (path != "/messages") continue;
                        seen++;
                        // The first send carries no id (the hub mints it), so it is
                        // matched by its text; the second is matched by its id.
                        if (body.IndexOf("hello from selftest", StringComparison.Ordinal) >= 0)
                        {
                            sawSilent = body.IndexOf("consent", StringComparison.Ordinal) < 0;
                        }
                        if (body.IndexOf(consentedId, StringComparison.Ordinal) >= 0)
                        {
                            sawLoud = body.IndexOf("\"consent\":true", StringComparison.Ordinal) >= 0;
                        }
                    }
                }
                Add("wire-consent-omitted", sawSilent && sawLoud,
                    "stub saw " + seen.ToString(CultureInfo.InvariantCulture) + " POST /messages (" + bodies.Summary()
                    + "); unchecked send carried no consent key=" + sawSilent + "; checked send carried consent:true=" + sawLoud);
            }
            catch (Exception ex) { Add("send-without-consent", false, ex.Message); }
            return id;
        }

        private static void DetailFlow(Client client, string id)
        {
            try
            {
                if (string.IsNullOrEmpty(id)) { Add("message-detail", false, "no id from the send step"); return; }
                MessageRow row;
                HubResponse r = client.GetMessage(id, out row);
                bool ok = r.Ok && row != null && row.Id == id && row.Attempts >= 0 && row.ExpiresAt > row.CreatedAt;
                Add("message-detail", ok, r.Summary() + " | status=" + (row == null ? "?" : row.Status)
                    + " attempts=" + (row == null ? "?" : row.Attempts.ToString(CultureInfo.InvariantCulture))
                    + " deferrals=" + (row == null ? "?" : row.Deferrals.ToString(CultureInfo.InvariantCulture))
                    + " settlement=" + (row == null ? "?" : row.Settlement)
                    + " everUncertain=" + (row != null && row.EverUncertain ? "yes" : "no")
                    + " retryable=" + (row != null && row.Retryable ? "yes" : "no"));
            }
            catch (Exception ex) { Add("message-detail", false, ex.Message); }
        }

        private static void RetryFlow(Client client, string id)
        {
            try
            {
                HubResponse ok = client.Retry(id ?? Guid.NewGuid().ToString());
                string text;
                string kind = RetryRules.Verdict(ok, out text);
                Add("retry-accepted", kind == RetryRules.OkKind && J.S(ok.Object, "status") == "queued" && J.N(ok.Object, "attempts") == 2,
                    "kind=" + kind + " | " + text + " | " + ok.Summary());

                HubResponse missing = Hub.Request(sharedConfig, "POST", "/messages/" + Guid.NewGuid().ToString() + "/retry-absent", new Body().ToJson());
                string missingText;
                string missingKind = RetryRules.Verdict(missing, out missingText);
                Add("retry-404-endpoint-missing", missingKind == RetryRules.EndpointMissing && missingText.IndexOf("endpoint not deployed", StringComparison.Ordinal) >= 0,
                    "kind=" + missingKind + " | " + missingText);

                // UUID-shaped sentinels the stub answers with a scripted refusal;
                // they must look like ids because the real hub validates the id
                // before it looks at the row.
                HubResponse forbidden = Hub.Request(sharedConfig, "POST", "/messages/00000000-0000-4000-8000-000000000403/retry", new Body().ToJson());
                string forbiddenText;
                string forbiddenKind = RetryRules.Verdict(forbidden, out forbiddenText);
                Add("retry-403-credential", forbiddenKind == RetryRules.Credential && forbiddenText.IndexOf("credential is not allowed", StringComparison.Ordinal) >= 0,
                    "kind=" + forbiddenKind + " | " + forbiddenText);

                HubResponse conflict = Hub.Request(sharedConfig, "POST", "/messages/00000000-0000-4000-8000-000000000409/retry", new Body().ToJson());
                string conflictText;
                string conflictKind = RetryRules.Verdict(conflict, out conflictText);
                Add("retry-409-state", conflictKind == RetryRules.State && conflictText.IndexOf("state does not allow", StringComparison.Ordinal) >= 0,
                    "kind=" + conflictKind + " | " + conflictText);

                HubResponse gone = Hub.Request(sharedConfig, "POST", "/messages/" + Guid.NewGuid().ToString() + "/retry", new Body().ToJson());
                string goneText;
                string goneKind = RetryRules.Verdict(gone, out goneText);
                Add("retry-404-message-missing-is-not-endpoint-missing",
                    gone.Status == 404 && goneKind == RetryRules.NotFound && goneText.IndexOf("message not found", StringComparison.Ordinal) >= 0,
                    "kind=" + goneKind + " | " + goneText + " | " + gone.Summary());

                HubResponse full = Hub.Request(sharedConfig, "POST", "/messages/00000000-0000-4000-8000-000000000429/retry", new Body().ToJson());
                string fullText;
                string fullKind = RetryRules.Verdict(full, out fullText);
                Add("retry-429-queue-full", fullKind == RetryRules.QueueFull && fullText.IndexOf("queue is full", StringComparison.Ordinal) >= 0,
                    "kind=" + fullKind + " | " + fullText);

                HubResponse badId = Hub.Request(sharedConfig, "POST", "/messages/not-a-uuid/retry", new Body().ToJson());
                string badIdText;
                string badIdKind = RetryRules.Verdict(badId, out badIdText);
                Add("retry-400-bad-id", badIdKind == RetryRules.BadId && badIdText.IndexOf("rejected the message id", StringComparison.Ordinal) >= 0,
                    "kind=" + badIdKind + " | " + badIdText);
            }
            catch (Exception ex) { Add("retry-accepted", false, ex.Message); }
        }

        private static void AuthFlow(Config cfg)
        {
            try
            {
                Config bad = new Config();
                bad.Url = cfg.Url;
                bad.Token = "wrong-token-but-long-enough-to-pass-shape-check";
                bad.TimeoutMs = cfg.TimeoutMs;
                bad.Home = cfg.Home;
                bad.TokenFingerprint = "00000000";
                Client badClient = new Client(bad);
                NodesPayload payload;
                HubResponse r = badClient.GetNodes(out payload);
                Add("auth-failure-surfaced", !r.Ok && r.Status == 401 && payload == null && r.Summary().IndexOf("401", StringComparison.Ordinal) >= 0,
                    r.Summary());
            }
            catch (Exception ex) { Add("auth-failure-surfaced", false, ex.Message); }
        }

        private static void TransportFlow(Config cfg)
        {
            try
            {
                Config dead = new Config();
                dead.Url = "http://127.0.0.1:1";
                dead.Token = cfg.Token;
                dead.TimeoutMs = 800;
                dead.Home = cfg.Home;
                Client deadClient = new Client(dead);
                NodesPayload payload;
                HubResponse r = deadClient.GetNodes(out payload);
                Add("transport-failure-surfaced", r.TransportFailed && !r.Ok && payload == null && r.Summary().Length > 0, r.Summary());
            }
            catch (Exception ex) { Add("transport-failure-surfaced", false, "threw instead of reporting: " + ex.Message); }
        }

        private static void RetryClassification()
        {
            try
            {
                // Fallback path (a hub that does not send retryEligible): the
                // statuses the hub's RETRYABLE_FROM set accepts, and nothing else.
                string[] accepted = new string[] { "queued", "deferred", "expired", "failed" };
                string[] refused = new string[] { "delivering", "uncertain", "delivered", "" };
                bool ok = true;
                StringBuilder sb = new StringBuilder();
                foreach (string status in accepted)
                {
                    MessageRow row = new MessageRow();
                    row.Status = status;
                    bool allowed = RetryRules.IsRetryableRow(row);
                    ok = ok && allowed;
                    sb.Append(status).Append('=').Append(allowed ? "on" : "OFF!").Append(' ');
                }
                foreach (string status in refused)
                {
                    MessageRow row = new MessageRow();
                    row.Status = status;
                    bool allowed = RetryRules.IsRetryableRow(row);
                    ok = ok && !allowed;
                    sb.Append(status.Length == 0 ? "empty" : status).Append('=').Append(allowed ? "ON!" : "off(灰)").Append(' ');
                }
                // When the hub does publish retryEligible it outranks the fallback,
                // in both directions - that is the field the button follows.
                MessageRow hubSaysNo = new MessageRow();
                hubSaysNo.Status = "queued";
                hubSaysNo.RetryEligibleKnown = true;
                hubSaysNo.RetryEligible = false;
                MessageRow hubSaysYes = new MessageRow();
                hubSaysYes.Status = "odd-status";
                hubSaysYes.RetryEligibleKnown = true;
                hubSaysYes.RetryEligible = true;
                ok = ok && !RetryRules.IsRetryableRow(hubSaysNo) && RetryRules.IsRetryableRow(hubSaysYes)
                    && !RetryRules.IsRetryableRow(null);
                sb.Append("hub retryEligible=false outranks queued=on; retryEligible=true outranks unknown status; null=off");
                Add("retry-button-classification", ok, sb.ToString());
            }
            catch (Exception ex) { Add("retry-button-classification", false, ex.Message); }
        }
    }

    // Same headless discipline as --selftest but pointed at a real hub that the
    // caller started. A stub written from the same reading of the contract can
    // only prove the client agrees with itself, so this mode is what actually
    // pins the hand-written JSON, the field names and the error mapping to the
    // shipped hub.
    internal static class LiveTest
    {
        private static readonly List<string[]> Steps = new List<string[]>();

        internal static int Run(Config cfg, Options opts)
        {
            Steps.Clear();
            Client client = new Client(cfg);
            Stopwatch sw = Stopwatch.StartNew();
            string nodeId = "desktop-livetest";
            string target = "coder";
            string text = "hello\nfrom livetest";
            string sentId = null;

            try
            {
                HubResponse beat = Hub.Request(cfg, "POST", "/nodes/" + nodeId + "/heartbeat",
                    new Body().Set("instanceId", Guid.NewGuid().ToString()).Set("sessionId", Guid.NewGuid().ToString())
                        .Set("targets", new List<object>(new object[] { target })).ToJson());
                Add("live-register-node", beat.Ok && J.B(beat.Object, "ok"), beat.Summary());

                NodesPayload payload;
                HubResponse nodes = client.GetNodes(out payload);
                NodeRow found = null;
                if (payload != null)
                {
                    foreach (NodeRow n in payload.Nodes) if (n.Id == nodeId) found = n;
                }
                Add("live-nodes-list", nodes.Ok && found != null && found.Online && found.Targets == target
                    && found.Fingerprint.Length == 8 && payload.StoreAcl.Length > 0,
                    nodes.Summary() + " | found=" + (found == null ? "no" : found.Id + " online=" + found.Online
                    + " targets=" + found.Targets + " fingerprint=" + found.Fingerprint + " storeAcl=" + payload.StoreAcl
                    + " queueTtlMs=" + payload.QueueTtlMs.ToString(CultureInfo.InvariantCulture)
                    + " nodeQueueLimit=" + payload.NodeQueueLimit.ToString(CultureInfo.InvariantCulture)));

                List<string> ids;
                string note;
                HubResponse listing = client.ProbeListing(out ids, out note);
                // Measured, not assumed: the shipped hub answers an operator
                // credential on GET /messages with a refusal, because that route
                // is the node claim poll.
                Add("live-listing-refused", !listing.Ok && note != null && ids.Count == 0,
                    "http=" + listing.Status.ToString(CultureInfo.InvariantCulture) + " code=" + (listing.Code ?? "-") + " | " + note);

                MessageRow refused;
                HubResponse unknown = client.Send("never-registered-node", target, "hi", false, out refused);
                Add("live-send-unknown-node-refused", unknown.Status == 403 && unknown.Code == "UNKNOWN_NODE" && refused == null,
                    unknown.Summary());

                MessageRow row;
                HubResponse sent = client.Send(nodeId, target, text, false, out row);
                bool sentOk = sent.Ok && sent.Status == 202 && row != null && row.Status == "queued"
                    && row.Retryable && !row.Terminal && !row.Consent && row.ExpiresAt > row.CreatedAt
                    && row.Mode == "submit" && row.To == nodeId && row.Target == target;
                sentId = row == null ? null : row.Id;
                Add("live-send-queued", sentOk, sent.Summary() + " | id=" + sentId + " status=" + (row == null ? "?" : row.Status)
                    + " mode=" + (row == null ? "?" : row.Mode) + " (hub default when the client omits mode)"
                    + " retryable=" + (row != null && row.Retryable ? "yes" : "no")
                    + " expiresAt>createdAt=" + (row != null && row.ExpiresAt > row.CreatedAt ? "yes" : "no"));

                if (sentId != null)
                {
                    // The hub refuses to let a stored id be replayed with a louder
                    // consent flag; the client has to surface that, not hide it.
                    HubResponse replay = Hub.Request(cfg, "POST", "/messages",
                        new Body().Set("id", sentId).Set("to", nodeId).Set("target", target).Set("text", text).Set("consent", true).ToJson());
                    Add("live-consent-replay-conflict", replay.Status == 409 && replay.Code == "ID_CONFLICT", replay.Summary());

                    MessageRow detail;
                    HubResponse got = client.GetMessage(sentId, out detail);
                    Add("live-detail", got.Ok && detail != null && detail.Id == sentId && detail.Status == "queued"
                        && detail.Attempts == 0 && detail.Deferrals == 0 && detail.Text == text && !detail.EverUncertain,
                        got.Summary() + " | status=" + (detail == null ? "?" : detail.Status)
                        + " attempts=" + (detail == null ? "?" : detail.Attempts.ToString(CultureInfo.InvariantCulture))
                        + " textRoundTrip=" + (detail != null && detail.Text == text ? "exact" : "MISMATCH")
                        + " everUncertain=" + (detail != null && detail.EverUncertain ? "yes" : "no")
                        + " settlement=" + (detail == null || detail.Settlement.Length == 0 ? "null" : detail.Settlement));

                    HubResponse retry = client.Retry(sentId);
                    string retryText;
                    string kind = RetryRules.Verdict(retry, out retryText);
                    // Either the retry endpoint has landed or it has not; both are
                    // reported honestly and anything else is a client bug.
                    Add("live-retry-status-quo", kind == RetryRules.EndpointMissing || kind == RetryRules.OkKind,
                        "kind=" + kind + " | " + retryText + " | " + retry.Summary());
                }

                MessageRow gone;
                HubResponse missing = client.GetMessage(Guid.NewGuid().ToString(), out gone);
                Add("live-detail-unknown-id", missing.Status == 404 && missing.Code == "NOT_FOUND" && gone == null, missing.Summary());

                Config bad = new Config();
                bad.Url = cfg.Url;
                bad.Token = "wrong-token-but-long-enough-to-pass-shape-check";
                bad.TimeoutMs = cfg.TimeoutMs;
                bad.Home = cfg.Home;
                NodesPayload none;
                HubResponse unauthorized = new Client(bad).GetNodes(out none);
                Add("live-auth-refused", unauthorized.Status == 401 && none == null, unauthorized.Summary());
            }
            catch (Exception ex)
            {
                Add("live-unexpected-exception", false, ex.GetType().Name + ": " + Redact.Scrub(ex.Message));
            }

            return Report.Emit("livetest", cfg, Steps, sw.Elapsed.TotalMilliseconds, opts.OutPath);
        }

        private static void Add(string name, bool ok, string detail)
        {
            Steps.Add(new string[] { name, ok ? "true" : "false", detail });
        }
    }
}



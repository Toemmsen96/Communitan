using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.IO;
using System.Text;

namespace Communitan
{
    // Appends one JSON object per line: {t, dir, id, ...extra, data}. Thread-safe, flushed per line.
    internal static class TrafficLogger
    {
        private static readonly object writeLock = new object();
        private static StreamWriter writer;
        internal static string FilePath { get; private set; }

        internal static void Open(string path)
        {
            lock (writeLock)
            {
                if (writer != null)
                {
                    return;
                }
                try
                {
                    FilePath = path;
                    writer = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false));
                    writer.AutoFlush = true;
                    Communitan.logger.LogInfo($"Traffic log: {path}");
                }
                catch (Exception e)
                {
                    writer = null;
                    Communitan.logger.LogError($"Traffic log disabled, cannot open {path}: {e.Message}");
                }
            }
        }

        internal static void Close()
        {
            lock (writeLock)
            {
                writer?.Dispose();
                writer = null;
            }
        }

        // data: a JSON string (embedded as JSON if it parses, else as string) or any JToken-convertible object.
        internal static void Log(string dir, string id, object data, JObject extra = null)
        {
            if (writer == null)
            {
                return;
            }
            try
            {
                JObject line = new JObject
                {
                    ["t"] = DateTime.UtcNow.ToString("o"),
                    ["dir"] = dir,
                    ["id"] = id
                };
                if (extra != null)
                {
                    foreach (var prop in extra.Properties())
                    {
                        line[prop.Name] = prop.Value;
                    }
                }
                line["data"] = ToToken(data);
                string text = line.ToString(Formatting.None);
                lock (writeLock)
                {
                    writer?.WriteLine(text);
                }
            }
            catch (Exception e)
            {
                Communitan.logger.LogWarning($"Traffic log write failed ({dir} {id}): {e.Message}");
            }
        }

        internal static JToken ToToken(object data)
        {
            if (data == null)
            {
                return JValue.CreateNull();
            }
            if (data is JToken token)
            {
                return token;
            }
            if (data is string s)
            {
                string trimmed = s.TrimStart();
                if (trimmed.StartsWith("{") || trimmed.StartsWith("["))
                {
                    try
                    {
                        return JToken.Parse(s);
                    }
                    catch (JsonException)
                    {
                    }
                }
                return new JValue(s);
            }
            return JToken.FromObject(data);
        }
    }
}

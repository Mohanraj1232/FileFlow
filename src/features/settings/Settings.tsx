import { useState, useEffect } from "react";
import { Save, Plus, X, Sun, Moon, Monitor } from "lucide-react";
import type { AppSettings, ConflictPolicy } from "../../lib/types";
import { getSettings, updateSetting } from "../../lib/commands";
import { applyTheme as applyThemeToDocument } from "../../lib/theme";
import { useToast } from "../../components/Toast";
import Button from "../../components/Button";

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings>({
    conflict_default: "auto_rename",
    notification_level: "batched",
    theme: "system",
    scan_schedule_minutes: 60,
    ignore_patterns: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const { addToast } = useToast();

  useEffect(() => {
    (async () => {
      try {
        const s = await getSettings();
        setSettings(s);
      } catch (e) {
        addToast({ type: "error", text: `Failed to load settings: ${String(e)}` });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function applyTheme(theme: "light" | "dark" | "system") {
    setSettings((s) => ({ ...s, theme }));
    applyThemeToDocument(theme);
  }

  function addPattern() {
    const p = newPattern.trim();
    if (!p || settings.ignore_patterns.includes(p)) return;
    setSettings((s) => ({
      ...s,
      ignore_patterns: [...s.ignore_patterns, p],
    }));
    setNewPattern("");
  }

  function removePattern(pattern: string) {
    setSettings((s) => ({
      ...s,
      ignore_patterns: s.ignore_patterns.filter((p) => p !== pattern),
    }));
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await updateSetting("conflict_default", settings.conflict_default);
      await updateSetting("notification_level", settings.notification_level);
      await updateSetting("theme", settings.theme);
      await updateSetting(
        "scan_schedule_minutes",
        String(settings.scan_schedule_minutes),
      );
      await updateSetting(
        "ignore_patterns",
        JSON.stringify(settings.ignore_patterns),
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      addToast({ type: "error", text: `Failed to save settings: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div
          className="w-8 h-8 border-3 border-t-transparent rounded-full animate-spin"
          style={{ borderColor: "var(--accent)", borderTopColor: "transparent" }}
        />
      </div>
    );
  }

  const themeOptions: { value: "light" | "dark" | "system"; icon: typeof Sun; label: string }[] = [
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
    { value: "system", icon: Monitor, label: "System" },
  ];

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
          Settings
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
          Configure FileFlow behavior
        </p>
      </div>

      {/* Theme */}
      <div
        className="rounded-xl p-6"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <h2
          className="text-base font-semibold mb-4"
          style={{ color: "var(--text-primary)" }}
        >
          Appearance
        </h2>
        <label
          className="block text-xs font-medium mb-2"
          style={{ color: "var(--text-secondary)" }}
        >
          Theme
        </label>
        <div
          className="inline-flex rounded-lg overflow-hidden"
          style={{ border: "1px solid var(--border-color)" }}
        >
          {themeOptions.map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              onClick={() => applyTheme(value)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium cursor-pointer"
              style={{
                backgroundColor:
                  settings.theme === value
                    ? "var(--accent)"
                    : "var(--bg-secondary)",
                color:
                  settings.theme === value ? "white" : "var(--text-secondary)",
              }}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* File Handling */}
      <div
        className="rounded-xl p-6 space-y-5"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <h2
          className="text-base font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          File Handling
        </h2>

        <div>
          <label
            className="block text-xs font-medium mb-1.5"
            style={{ color: "var(--text-secondary)" }}
          >
            Default conflict policy
          </label>
          <select
            value={settings.conflict_default}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                conflict_default: e.target.value as ConflictPolicy,
              }))
            }
            className="w-full max-w-sm px-3 py-2 rounded-lg text-sm cursor-pointer"
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
          >
            <option value="auto_rename">Auto-rename (e.g., file (2).pdf)</option>
            <option value="skip">Skip</option>
            <option value="replace_if_duplicate">
              Replace if duplicate (same hash)
            </option>
          </select>
        </div>

        <div>
          <label
            className="block text-xs font-medium mb-1.5"
            style={{ color: "var(--text-secondary)" }}
          >
            Notification level
          </label>
          <select
            value={settings.notification_level}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                notification_level: e.target.value as AppSettings["notification_level"],
              }))
            }
            className="w-full max-w-sm px-3 py-2 rounded-lg text-sm cursor-pointer"
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
          >
            <option value="all">All (one per file)</option>
            <option value="batched">Batched (summary every few files)</option>
            <option value="errors_only">Errors only</option>
            <option value="none">None</option>
          </select>
        </div>

        <div>
          <label
            className="block text-xs font-medium mb-1.5"
            style={{ color: "var(--text-secondary)" }}
          >
            Scan schedule (minutes)
          </label>
          <input
            type="number"
            min={5}
            max={1440}
            value={settings.scan_schedule_minutes}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                scan_schedule_minutes: Number(e.target.value) || 60,
              }))
            }
            className="w-32 px-3 py-2 rounded-lg text-sm outline-none"
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
          />
        </div>
      </div>

      {/* Ignore Patterns */}
      <div
        className="rounded-xl p-6"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <h2
          className="text-base font-semibold mb-4"
          style={{ color: "var(--text-primary)" }}
        >
          Ignore Patterns
        </h2>
        <p
          className="text-xs mb-3"
          style={{ color: "var(--text-secondary)" }}
        >
          Files matching these patterns will always be skipped.
        </p>

        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            placeholder="e.g., *.tmp, .DS_Store"
            className="flex-1 max-w-sm px-3 py-2 rounded-lg text-sm outline-none"
            style={{
              backgroundColor: "var(--bg-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
            onKeyDown={(e) => e.key === "Enter" && addPattern()}
          />
          <button
            onClick={addPattern}
            className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium cursor-pointer"
            style={{
              backgroundColor: "var(--bg-tertiary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
          >
            <Plus size={14} />
            Add
          </button>
        </div>

        {settings.ignore_patterns.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {settings.ignore_patterns.map((p) => (
              <span
                key={p}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono"
                style={{
                  backgroundColor: "var(--bg-tertiary)",
                  color: "var(--text-secondary)",
                }}
              >
                {p}
                <button
                  onClick={() => removePattern(p)}
                  className="cursor-pointer"
                  style={{ color: "var(--text-muted)" }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.color = "var(--danger)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.color = "var(--text-muted)")
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Save */}
      <div className="flex items-center gap-3 pb-8">
        <Button
          variant="primary"
          onClick={handleSave}
          loading={saving}
          icon={<Save size={16} />}
        >
          {saving ? "Saving..." : "Save Settings"}
        </Button>
        {saved && (
          <span className="text-sm" style={{ color: "var(--success)" }}>
            Settings saved!
          </span>
        )}
      </div>
    </div>
  );
}

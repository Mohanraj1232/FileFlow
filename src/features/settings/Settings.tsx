import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { Save, Plus, X, Sun, Moon, Monitor } from "lucide-react";
import type { AppSettings, ConflictPolicy } from "../../lib/types";
import { getSettings, updateSetting } from "../../lib/commands";
import { applyTheme as applyThemeToDocument } from "../../lib/theme";
import { useToast } from "../../components/Toast";
import Button from "../../components/ui/Button";
import PageHeader from "../../components/ui/PageHeader";
import { Card, CardHeader, CardBody } from "../../components/ui/Card";
import { Input, Select } from "../../components/ui/Field";
import { LoadingState } from "../../components/ui/Spinner";

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{label}</p>
        {description && (
          <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

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

  if (loading) return <LoadingState />;

  const themeOptions: { value: "light" | "dark" | "system"; icon: typeof Sun; label: string }[] = [
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
    { value: "system", icon: Monitor, label: "System" },
  ];

  return (
    <div>
      <PageHeader title="Settings" description="Configure FileFlow behavior" />

      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader title="Appearance" />
          <CardBody>
            <SettingRow label="Theme" description="Applies immediately and syncs the title bar">
              <div className="inline-flex overflow-hidden rounded-md border border-border">
                {themeOptions.map(({ value, icon: Icon, label }) => (
                  <button
                    key={value}
                    onClick={() => applyTheme(value)}
                    className={`flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                      settings.theme === value
                        ? "bg-accent text-white"
                        : "bg-inset text-fg-muted hover:text-fg"
                    }`}
                  >
                    <Icon size={13} />
                    {label}
                  </button>
                ))}
              </div>
            </SettingRow>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="File Handling" />
          <CardBody className="space-y-4">
            <SettingRow label="Default conflict policy">
              <Select
                value={settings.conflict_default}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    conflict_default: e.target.value as ConflictPolicy,
                  }))
                }
                className="w-64"
              >
                <option value="auto_rename">Auto-rename (e.g., file (2).pdf)</option>
                <option value="skip">Skip</option>
                <option value="replace_if_duplicate">
                  Replace if duplicate (same hash)
                </option>
              </Select>
            </SettingRow>

            <SettingRow label="Notification level">
              <Select
                value={settings.notification_level}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    notification_level: e.target.value as AppSettings["notification_level"],
                  }))
                }
                className="w-64"
              >
                <option value="all">All (one per file)</option>
                <option value="batched">Batched (summary every few files)</option>
                <option value="errors_only">Errors only</option>
                <option value="none">None</option>
              </Select>
            </SettingRow>

            <SettingRow
              label="Scan schedule"
              description="How often watched folders are rescanned, in minutes"
            >
              <Input
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
                className="w-24"
              />
            </SettingRow>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Ignore Patterns"
            description="Files matching these patterns will always be skipped"
          />
          <CardBody>
            <div className="mb-3 flex gap-2">
              <Input
                type="text"
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                placeholder="e.g., *.tmp, .DS_Store"
                className="max-w-sm flex-1"
                onKeyDown={(e) => e.key === "Enter" && addPattern()}
              />
              <Button variant="secondary" icon={<Plus size={14} />} onClick={addPattern}>
                Add
              </Button>
            </div>

            {settings.ignore_patterns.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {settings.ignore_patterns.map((p) => (
                  <span
                    key={p}
                    className="inline-flex items-center gap-1.5 rounded-full bg-hover px-2.5 py-1 font-mono text-xs text-fg-muted"
                  >
                    {p}
                    <button
                      onClick={() => removePattern(p)}
                      className="cursor-pointer text-fg-subtle transition-colors hover:text-danger"
                      aria-label={`Remove pattern ${p}`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <div className="sticky bottom-4 flex items-center gap-3 rounded-xl border border-border bg-surface px-5 py-4 shadow-pop">
          <Button
            variant="primary"
            onClick={handleSave}
            loading={saving}
            icon={<Save size={16} />}
          >
            {saving ? "Saving..." : "Save Settings"}
          </Button>
          {saved && <span className="text-sm text-success">Settings saved!</span>}
        </div>
      </div>
    </div>
  );
}

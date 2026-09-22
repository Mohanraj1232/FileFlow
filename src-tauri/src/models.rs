use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Document,
    Image,
    Video,
    Audio,
    Archive,
    Code,
    Installer,
    Other,
}

impl FileKind {
    pub fn as_str(&self) -> &str {
        match self {
            FileKind::Document => "document",
            FileKind::Image => "image",
            FileKind::Video => "video",
            FileKind::Audio => "audio",
            FileKind::Archive => "archive",
            FileKind::Code => "code",
            FileKind::Installer => "installer",
            FileKind::Other => "other",
        }
    }
}

pub fn extension_to_kind(ext: &str) -> FileKind {
    match ext.to_lowercase().as_str() {
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp"
        | "rtf" | "txt" | "csv" | "epub" | "pages" | "numbers" | "key" => FileKind::Document,

        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "svg" | "webp" | "heic" | "heif" | "ico"
        | "tiff" | "tif" | "raw" | "cr2" | "nef" | "psd" | "ai" | "avif" => FileKind::Image,

        "mp4" | "avi" | "mkv" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg"
        | "3gp" | "vob" | "ts" => FileKind::Video,

        "mp3" | "wav" | "flac" | "aac" | "ogg" | "wma" | "m4a" | "opus" | "aiff" | "alac" => {
            FileKind::Audio
        }

        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "lz" | "cab" | "iso"
        | "dmg" => FileKind::Archive,

        "rs" | "js" | "ts" | "jsx" | "tsx" | "py" | "java" | "c" | "cpp" | "h" | "hpp" | "cs"
        | "go" | "rb" | "php" | "swift" | "kt" | "scala" | "lua" | "r" | "m" | "sh" | "bash"
        | "ps1" | "bat" | "cmd" | "sql" | "html" | "css" | "scss" | "sass" | "less" | "json"
        | "xml" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "md" | "markdown"
        | "vue" | "svelte" | "dart" | "zig" | "nim" | "ex" | "exs" | "erl" | "hs"
        | "clj" | "v" | "vhdl" => FileKind::Code,

        "exe" | "msi" | "deb" | "rpm" | "appimage" | "snap" | "flatpak" | "pkg" | "apk"
        | "ipa" => FileKind::Installer,

        _ => FileKind::Other,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMeta {
    pub name: String,
    pub extension: String,
    pub size: u64,
    pub mtime: String,
    pub kind: FileKind,
    pub path: String,
    pub source_folder: String,
}

impl FileMeta {
    pub fn from_path(path: &Path) -> std::io::Result<Self> {
        let metadata = std::fs::metadata(path)?;
        let name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let extension = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let kind = extension_to_kind(&extension);
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|d| {
                        chrono::DateTime::from_timestamp(d.as_secs() as i64, d.subsec_nanos())
                            .unwrap_or_default()
                            .format("%Y-%m-%dT%H:%M:%S")
                            .to_string()
                    })
            })
            .unwrap_or_default();
        let source_folder = path
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .to_string();

        Ok(Self {
            name,
            extension,
            size: metadata.len(),
            mtime,
            kind,
            path: path.to_string_lossy().to_string(),
            source_folder,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionField {
    Extension,
    Name,
    Size,
    Kind,
    SourceFolder,
    CreatedAge,
    ModifiedAge,
    IsDuplicate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionOp {
    Is,
    In,
    NotIn,
    Contains,
    StartsWith,
    EndsWith,
    Equals,
    Matches,
    Glob,
    Gt,
    Lt,
    Between,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConditionLeaf {
    pub field: ConditionField,
    pub op: ConditionOp,
    pub value: serde_json::Value,
    #[serde(default)]
    pub case_sensitive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Condition {
    Group {
        #[serde(skip_serializing_if = "Option::is_none")]
        all: Option<Vec<Condition>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        any: Option<Vec<Condition>>,
    },
    Leaf(ConditionLeaf),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerType {
    Arrival,
    Scan,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionType {
    Move,
    Copy,
    Rename,
    Trash,
    Ignore,
}

impl ActionType {
    pub fn as_str(&self) -> &str {
        match self {
            ActionType::Move => "move",
            ActionType::Copy => "copy",
            ActionType::Rename => "rename",
            ActionType::Trash => "trash",
            ActionType::Ignore => "ignore",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "move" => ActionType::Move,
            "copy" => ActionType::Copy,
            "rename" => ActionType::Rename,
            "trash" => ActionType::Trash,
            "ignore" => ActionType::Ignore,
            _ => ActionType::Move,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    AutoRename,
    Skip,
    ReplaceIfDuplicate,
    Ask,
}

impl ConflictPolicy {
    pub fn as_str(&self) -> &str {
        match self {
            ConflictPolicy::AutoRename => "auto_rename",
            ConflictPolicy::Skip => "skip",
            ConflictPolicy::ReplaceIfDuplicate => "replace_if_duplicate",
            ConflictPolicy::Ask => "ask",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "auto_rename" => ConflictPolicy::AutoRename,
            "skip" => ConflictPolicy::Skip,
            "replace_if_duplicate" => ConflictPolicy::ReplaceIfDuplicate,
            "ask" => ConflictPolicy::Ask,
            _ => ConflictPolicy::AutoRename,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_conflict: Option<ConflictPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleAction {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<i64>,
    pub position: i32,
    pub action_type: ActionType,
    pub params: ActionParams,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub name: String,
    pub enabled: bool,
    pub priority: i32,
    pub trigger: TriggerType,
    pub condition: Condition,
    pub stop_after: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_folder: Option<i64>,
    pub actions: Vec<RuleAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchedFolder {
    pub id: i64,
    pub path: String,
    pub recursive: bool,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationSource {
    Watcher,
    Scan,
    Manual,
}

impl OperationSource {
    pub fn as_str(&self) -> &str {
        match self {
            OperationSource::Watcher => "watcher",
            OperationSource::Scan => "scan",
            OperationSource::Manual => "manual",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "watcher" => OperationSource::Watcher,
            "scan" => OperationSource::Scan,
            "manual" => OperationSource::Manual,
            _ => OperationSource::Manual,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Planned,
    Running,
    Done,
    Partial,
    Failed,
    Undone,
}

impl OperationStatus {
    pub fn as_str(&self) -> &str {
        match self {
            OperationStatus::Planned => "planned",
            OperationStatus::Running => "running",
            OperationStatus::Done => "done",
            OperationStatus::Partial => "partial",
            OperationStatus::Failed => "failed",
            OperationStatus::Undone => "undone",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "planned" => OperationStatus::Planned,
            "running" => OperationStatus::Running,
            "done" => OperationStatus::Done,
            "partial" => OperationStatus::Partial,
            "failed" => OperationStatus::Failed,
            "undone" => OperationStatus::Undone,
            _ => OperationStatus::Planned,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Done,
    Failed,
    Undone,
    Skipped,
}

impl StepStatus {
    pub fn as_str(&self) -> &str {
        match self {
            StepStatus::Pending => "pending",
            StepStatus::Done => "done",
            StepStatus::Failed => "failed",
            StepStatus::Undone => "undone",
            StepStatus::Skipped => "skipped",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "pending" => StepStatus::Pending,
            "done" => StepStatus::Done,
            "failed" => StepStatus::Failed,
            "undone" => StepStatus::Undone,
            "skipped" => StepStatus::Skipped,
            _ => StepStatus::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operation {
    pub id: i64,
    pub source: String,
    pub status: String,
    pub summary: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<OperationStep>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationStep {
    pub id: i64,
    pub operation_id: i64,
    pub seq: i32,
    pub rule_id: Option<i64>,
    pub action_type: String,
    pub src_path: String,
    pub dst_path: Option<String>,
    pub file_size: Option<i64>,
    pub file_mtime: Option<String>,
    pub content_hash: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub executed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedStep {
    pub rule_id: Option<i64>,
    pub rule_name: String,
    pub action_type: String,
    pub src_path: String,
    pub dst_path: Option<String>,
    pub file_size: u64,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanSummary {
    pub steps: Vec<PlannedStep>,
    pub move_count: usize,
    pub copy_count: usize,
    pub rename_count: usize,
    pub trash_count: usize,
    pub skip_count: usize,
    pub no_match_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoResult {
    pub success: bool,
    pub steps_undone: usize,
    pub steps_skipped: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub conflict_default: String,
    pub notification_level: String,
    pub theme: String,
    pub scan_schedule_minutes: i32,
    pub ignore_patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardStats {
    pub files_organized_today: usize,
    pub files_organized_week: usize,
    pub active_rules: usize,
    pub watched_folders: usize,
    pub recent_operations: Vec<Operation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnsortedFile {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: u64,
    pub kind: FileKind,
    pub modified_at: String,
}

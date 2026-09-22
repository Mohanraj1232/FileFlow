use notify_debouncer_full::{
    new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer,
    FileIdMap,
};
use notify::RecommendedWatcher;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub type WatcherHandle = Debouncer<RecommendedWatcher, FileIdMap>;

const TEMP_EXTENSIONS: &[&str] = &[
    "crdownload",
    "part",
    "partial",
    "tmp",
    "download",
    "opdownload",
];

const IGNORED_FILES: &[&str] = &[
    ".DS_Store",
    "desktop.ini",
    "Thumbs.db",
];

const STABILITY_CHECK_INTERVAL: Duration = Duration::from_secs(2);
const STABILITY_MAX_RETRIES: u32 = 5;
const RECENTLY_WRITTEN_TTL: Duration = Duration::from_secs(30);

pub struct FileEvent {
    pub path: PathBuf,
}

pub struct RecentlyWritten {
    entries: HashMap<String, Instant>,
}

impl RecentlyWritten {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    pub fn add(&mut self, path: &str) {
        self.entries.insert(path.to_string(), Instant::now());
    }

    pub fn add_all(&mut self, paths: &HashSet<String>) {
        let now = Instant::now();
        for path in paths {
            self.entries.insert(path.clone(), now);
        }
    }

    pub fn contains(&self, path: &str) -> bool {
        if let Some(instant) = self.entries.get(path) {
            instant.elapsed() < RECENTLY_WRITTEN_TTL
        } else {
            false
        }
    }

    pub fn cleanup(&mut self) {
        self.entries
            .retain(|_, instant| instant.elapsed() < RECENTLY_WRITTEN_TTL);
    }
}

pub fn should_ignore_file(path: &Path) -> bool {
    let filename = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();

    if filename.starts_with("~$") {
        return true;
    }

    if IGNORED_FILES.iter().any(|f| filename == *f) {
        return true;
    }

    if let Some(ext) = path.extension() {
        let ext_lower = ext.to_string_lossy().to_lowercase();
        if TEMP_EXTENSIONS.contains(&ext_lower.as_str()) {
            return true;
        }
    }

    false
}

pub fn is_file_stable(path: &Path) -> bool {
    for _ in 0..STABILITY_MAX_RETRIES {
        let first = match get_file_snapshot(path) {
            Some(s) => s,
            None => return false,
        };

        std::thread::sleep(STABILITY_CHECK_INTERVAL);

        let second = match get_file_snapshot(path) {
            Some(s) => s,
            None => return false,
        };

        if first.size == second.size && first.mtime == second.mtime {
            if can_open_file(path) {
                return true;
            }
        }
    }

    false
}

struct FileSnapshot {
    size: u64,
    mtime: std::time::SystemTime,
}

fn get_file_snapshot(path: &Path) -> Option<FileSnapshot> {
    let meta = std::fs::metadata(path).ok()?;
    Some(FileSnapshot {
        size: meta.len(),
        mtime: meta.modified().ok()?,
    })
}

fn can_open_file(path: &Path) -> bool {
    std::fs::File::open(path).is_ok()
}

pub fn create_watcher(
    tx: mpsc::Sender<FileEvent>,
) -> Result<WatcherHandle, String> {
    let debouncer = new_debouncer(
        Duration::from_secs(2),
        None,
        move |result: DebounceEventResult| {
            match result {
                Ok(events) => {
                    for event in events {
                        for path in event.paths {
                            if path.is_file() && !should_ignore_file(&path) {
                                tx.send(FileEvent {
                                    path: path.clone(),
                                })
                                .ok();
                            }
                        }
                    }
                }
                Err(errors) => {
                    for error in errors {
                        log::error!("Watcher error: {:?}", error);
                    }
                }
            }
        },
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    Ok(debouncer)
}

pub fn watch_folder(
    debouncer: &mut WatcherHandle,
    path: &Path,
    recursive: bool,
) -> Result<(), String> {
    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    debouncer
        .watcher()
        .watch(path, mode)
        .map_err(|e| format!("Failed to watch {}: {}", path.display(), e))?;
    debouncer
        .cache()
        .add_root(path, mode);
    Ok(())
}

pub fn unwatch_folder(debouncer: &mut WatcherHandle, path: &Path) -> Result<(), String> {
    debouncer
        .watcher()
        .unwatch(path)
        .map_err(|e| format!("Failed to unwatch {}: {}", path.display(), e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_ignore_temp_files() {
        assert!(should_ignore_file(Path::new("/downloads/file.crdownload")));
        assert!(should_ignore_file(Path::new("/downloads/file.part")));
        assert!(should_ignore_file(Path::new("/downloads/file.tmp")));
        assert!(should_ignore_file(Path::new("/downloads/.DS_Store")));
        assert!(should_ignore_file(Path::new("/downloads/desktop.ini")));
        assert!(should_ignore_file(Path::new("/downloads/~$document.docx")));
    }

    #[test]
    fn test_should_not_ignore_normal_files() {
        assert!(!should_ignore_file(Path::new("/downloads/report.pdf")));
        assert!(!should_ignore_file(Path::new("/downloads/photo.jpg")));
    }

    #[test]
    fn test_recently_written() {
        let mut rw = RecentlyWritten::new();
        rw.add("/docs/report.pdf");
        assert!(rw.contains("/docs/report.pdf"));
        assert!(!rw.contains("/docs/other.pdf"));
    }
}

use crate::models::{ActionType, FileMeta, PlannedStep, PlanSummary, Rule, RuleAction, ConflictPolicy};
use chrono::Local;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub fn plan(
    file_meta: &FileMeta,
    rule: &Rule,
    actions: &[RuleAction],
    existing_files: &HashSet<PathBuf>,
) -> Vec<PlannedStep> {
    let mut steps = Vec::new();
    let mut current_path = PathBuf::from(&file_meta.path);
    let mut current_name = file_meta.name.clone();
    let mut current_ext = file_meta.extension.clone();

    for action in actions {
        let action_type = action.action_type.as_str();
        match &action.action_type {
            ActionType::Move | ActionType::Copy => {
                if let Some(dest_template) = &action.params.destination {
                    let dest_dir = expand_variables(dest_template, file_meta);
                    let filename = if current_ext.is_empty() {
                        current_name.clone()
                    } else {
                        format!("{}.{}", current_name, current_ext)
                    };
                    let mut dest_path = PathBuf::from(&dest_dir).join(&filename);

                    let conflict_policy = action
                        .params
                        .on_conflict
                        .as_ref()
                        .unwrap_or(&ConflictPolicy::AutoRename);

                    dest_path = resolve_conflict(dest_path, existing_files, conflict_policy);

                    steps.push(PlannedStep {
                        rule_id: rule.id,
                        rule_name: rule.name.clone(),
                        action_type: action_type.to_string(),
                        src_path: current_path.to_string_lossy().to_string(),
                        dst_path: Some(dest_path.to_string_lossy().to_string()),
                        file_size: file_meta.size,
                        selected: true,
                    });

                    if matches!(&action.action_type, ActionType::Move) {
                        current_path = dest_path;
                    }
                }
            }
            ActionType::Rename => {
                if let Some(pattern) = &action.params.pattern {
                    let new_filename = expand_rename_pattern(pattern, file_meta);
                    let parent = current_path
                        .parent()
                        .unwrap_or(Path::new(""))
                        .to_path_buf();
                    let dest_path = parent.join(&new_filename);

                    steps.push(PlannedStep {
                        rule_id: rule.id,
                        rule_name: rule.name.clone(),
                        action_type: action_type.to_string(),
                        src_path: current_path.to_string_lossy().to_string(),
                        dst_path: Some(dest_path.to_string_lossy().to_string()),
                        file_size: file_meta.size,
                        selected: true,
                    });

                    current_path = dest_path;
                    if let Some(stem) = current_path.file_stem() {
                        current_name = stem.to_string_lossy().to_string();
                    }
                    if let Some(ext) = current_path.extension() {
                        current_ext = ext.to_string_lossy().to_string();
                    }
                }
            }
            ActionType::Trash => {
                steps.push(PlannedStep {
                    rule_id: rule.id,
                    rule_name: rule.name.clone(),
                    action_type: action_type.to_string(),
                    src_path: current_path.to_string_lossy().to_string(),
                    dst_path: None,
                    file_size: file_meta.size,
                    selected: true,
                });
            }
            ActionType::Ignore => {
                steps.push(PlannedStep {
                    rule_id: rule.id,
                    rule_name: rule.name.clone(),
                    action_type: "ignore".to_string(),
                    src_path: current_path.to_string_lossy().to_string(),
                    dst_path: None,
                    file_size: file_meta.size,
                    selected: true,
                });
            }
        }
    }

    steps
}

pub fn build_summary(steps: &[PlannedStep], unmatched_count: usize) -> PlanSummary {
    let mut move_count = 0;
    let mut copy_count = 0;
    let mut rename_count = 0;
    let mut trash_count = 0;
    let mut skip_count = 0;

    for step in steps {
        if !step.selected {
            skip_count += 1;
            continue;
        }
        match step.action_type.as_str() {
            "move" => move_count += 1,
            "copy" => copy_count += 1,
            "rename" => rename_count += 1,
            "trash" => trash_count += 1,
            "ignore" => skip_count += 1,
            _ => {}
        }
    }

    PlanSummary {
        steps: steps.to_vec(),
        move_count,
        copy_count,
        rename_count,
        trash_count,
        skip_count,
        no_match_count: unmatched_count,
    }
}

fn expand_variables(template: &str, meta: &FileMeta) -> String {
    let now = Local::now();
    let mut result = template.to_string();

    result = result.replace("{kind}", meta.kind.as_str());
    result = result.replace("{ext}", &meta.extension);
    result = result.replace("{name}", &meta.name);
    result = result.replace("{year}", &now.format("%Y").to_string());
    result = result.replace("{month}", &now.format("%m").to_string());
    result = result.replace("{date}", &now.format("%Y-%m-%d").to_string());
    result = result.replace("{date:YYYY-MM-DD}", &now.format("%Y-%m-%d").to_string());
    result = result.replace("{date:YYYY-MM}", &now.format("%Y-%m").to_string());
    result = result.replace("{date:YYYY}", &now.format("%Y").to_string());

    result
}

fn expand_rename_pattern(pattern: &str, meta: &FileMeta) -> String {
    let now = Local::now();
    let mut result = pattern.to_string();

    result = result.replace("{name}", &meta.name);
    result = result.replace("{name:lower}", &meta.name.to_lowercase());
    result = result.replace("{name:clean}", &clean_filename(&meta.name));
    result = result.replace("{name:slug}", &slugify(&meta.name));
    result = result.replace("{ext}", &meta.extension);
    result = result.replace("{kind}", meta.kind.as_str());
    result = result.replace("{date}", &now.format("%Y-%m-%d").to_string());
    result = result.replace("{date:YYYY-MM-DD}", &now.format("%Y-%m-%d").to_string());
    result = result.replace("{date:YYYY-MM}", &now.format("%Y-%m").to_string());
    result = result.replace("{date:YYYY}", &now.format("%Y").to_string());

    result
}

fn clean_filename(name: &str) -> String {
    let mut cleaned = name.to_string();
    let patterns = [
        r"\s*\(\d+\)\s*",
        r"\s*_final\d*\s*",
        r"\s*-\s*copy\s*",
        r"\s*copy\s*\d*\s*",
        r"\s*\(copy\)\s*",
    ];
    for pat in &patterns {
        if let Ok(re) = regex::Regex::new(&format!("(?i){}", pat)) {
            cleaned = re.replace_all(&cleaned, "").to_string();
        }
    }
    cleaned.trim().to_string()
}

fn slugify(name: &str) -> String {
    let lower = name.to_lowercase();
    let re = regex::Regex::new(r"[^a-z0-9]+").unwrap();
    let slug = re.replace_all(&lower, "-").to_string();
    slug.trim_matches('-').to_string()
}

fn resolve_conflict(
    mut dest: PathBuf,
    existing: &HashSet<PathBuf>,
    policy: &ConflictPolicy,
) -> PathBuf {
    match policy {
        ConflictPolicy::AutoRename => {
            if !existing.contains(&dest) && !dest.exists() {
                return dest;
            }

            let stem = dest
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let ext = dest
                .extension()
                .map(|e| e.to_string_lossy().to_string());
            let parent = dest.parent().unwrap_or(Path::new("")).to_path_buf();

            for i in 2..=999 {
                let new_name = if let Some(ref ext) = ext {
                    format!("{} ({}).{}", stem, i, ext)
                } else {
                    format!("{} ({})", stem, i)
                };
                dest = parent.join(&new_name);
                if !existing.contains(&dest) && !dest.exists() {
                    return dest;
                }
            }
            dest
        }
        ConflictPolicy::Skip => dest,
        ConflictPolicy::ReplaceIfDuplicate => dest,
        ConflictPolicy::Ask => dest,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::*;

    #[test]
    fn test_expand_variables() {
        let meta = FileMeta {
            name: "report".to_string(),
            extension: "pdf".to_string(),
            size: 1024,
            mtime: "2026-01-01T00:00:00".to_string(),
            kind: FileKind::Document,
            path: "/downloads/report.pdf".to_string(),
            source_folder: "/downloads".to_string(),
        };
        let result = expand_variables("Documents/{kind}", &meta);
        assert_eq!(result, "Documents/document");
    }

    #[test]
    fn test_clean_filename() {
        assert_eq!(clean_filename("report_final_final2"), "report");
        assert_eq!(clean_filename("file (1)"), "file");
        assert_eq!(clean_filename("document - copy"), "document");
    }

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("My Document Name"), "my-document-name");
        assert_eq!(slugify("report_final (2)"), "report-final-2");
    }

    #[test]
    fn test_resolve_conflict() {
        let mut existing = HashSet::new();
        existing.insert(PathBuf::from("/docs/report.pdf"));

        let result = resolve_conflict(
            PathBuf::from("/docs/report.pdf"),
            &existing,
            &ConflictPolicy::AutoRename,
        );
        assert_eq!(result, PathBuf::from("/docs/report (2).pdf"));
    }

    #[test]
    fn test_plan_move_action() {
        let meta = FileMeta {
            name: "report".to_string(),
            extension: "pdf".to_string(),
            size: 1024,
            mtime: "2026-01-01T00:00:00".to_string(),
            kind: FileKind::Document,
            path: "/downloads/report.pdf".to_string(),
            source_folder: "/downloads".to_string(),
        };
        let rule = Rule {
            id: Some(1),
            name: "PDF rule".to_string(),
            enabled: true,
            priority: 1,
            trigger: TriggerType::Arrival,
            condition: Condition::Leaf(ConditionLeaf {
                field: ConditionField::Extension,
                op: ConditionOp::Is,
                value: serde_json::json!("pdf"),
                case_sensitive: None,
            }),
            stop_after: true,
            scope_folder: None,
            actions: vec![],
            created_at: None,
            updated_at: None,
        };
        let actions = vec![RuleAction {
            id: None,
            rule_id: None,
            position: 0,
            action_type: ActionType::Move,
            params: ActionParams {
                destination: Some("/documents/{kind}".to_string()),
                pattern: None,
                on_conflict: None,
            },
        }];
        let existing = HashSet::new();
        let steps = plan(&meta, &rule, &actions, &existing);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].action_type, "move");
        assert!(steps[0].dst_path.as_ref().unwrap().contains("document"));
    }
}

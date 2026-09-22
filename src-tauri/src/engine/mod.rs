use crate::models::{
    Condition, ConditionField, ConditionLeaf, ConditionOp, FileMeta, FileKind, Rule, RuleAction,
    TriggerType,
};
use globset::GlobBuilder;
use regex::Regex;

pub struct MatchResult {
    pub rule: Rule,
    pub actions: Vec<RuleAction>,
}

pub fn evaluate(file_meta: &FileMeta, rules: &[Rule], trigger: &TriggerType) -> Option<MatchResult> {
    let mut sorted_rules: Vec<&Rule> = rules
        .iter()
        .filter(|r| r.enabled)
        .filter(|r| trigger_matches(&r.trigger, trigger))
        .collect();

    sorted_rules.sort_by_key(|r| r.priority);

    for rule in sorted_rules {
        if evaluate_condition(&rule.condition, file_meta) {
            return Some(MatchResult {
                rule: rule.clone(),
                actions: rule.actions.clone(),
            });
        }
    }

    None
}

fn trigger_matches(rule_trigger: &TriggerType, event_trigger: &TriggerType) -> bool {
    match (rule_trigger, event_trigger) {
        (TriggerType::Both, _) => true,
        (TriggerType::Arrival, TriggerType::Arrival) => true,
        (TriggerType::Scan, TriggerType::Scan) => true,
        _ => false,
    }
}

fn evaluate_condition(condition: &Condition, meta: &FileMeta) -> bool {
    match condition {
        Condition::Group { all, any } => {
            if let Some(conditions) = all {
                conditions.iter().all(|c| evaluate_condition(c, meta))
            } else if let Some(conditions) = any {
                conditions.iter().any(|c| evaluate_condition(c, meta))
            } else {
                true
            }
        }
        Condition::Leaf(leaf) => evaluate_leaf(leaf, meta),
    }
}

fn evaluate_leaf(leaf: &ConditionLeaf, meta: &FileMeta) -> bool {
    let case_sensitive = leaf.case_sensitive.unwrap_or(false);

    match leaf.field {
        ConditionField::Extension => evaluate_extension(&leaf.op, &leaf.value, &meta.extension),
        ConditionField::Name => evaluate_name(&leaf.op, &leaf.value, &meta.name, case_sensitive),
        ConditionField::Size => evaluate_size(&leaf.op, &leaf.value, meta.size),
        ConditionField::Kind => evaluate_kind(&leaf.op, &leaf.value, &meta.kind),
        ConditionField::SourceFolder => evaluate_source_folder(&leaf.op, &leaf.value, &meta.source_folder),
        ConditionField::CreatedAge | ConditionField::ModifiedAge => false,
        ConditionField::IsDuplicate => false,
    }
}

fn evaluate_extension(op: &ConditionOp, value: &serde_json::Value, ext: &str) -> bool {
    let ext_lower = ext.to_lowercase();
    match op {
        ConditionOp::Is | ConditionOp::Equals => {
            if let Some(s) = value.as_str() {
                ext_lower == s.to_lowercase()
            } else {
                false
            }
        }
        ConditionOp::In => match value {
            serde_json::Value::Array(arr) => arr.iter().any(|v| {
                v.as_str()
                    .map(|s| ext_lower == s.to_lowercase())
                    .unwrap_or(false)
            }),
            serde_json::Value::String(s) => ext_lower == s.to_lowercase(),
            _ => false,
        },
        ConditionOp::NotIn => match value {
            serde_json::Value::Array(arr) => !arr.iter().any(|v| {
                v.as_str()
                    .map(|s| ext_lower == s.to_lowercase())
                    .unwrap_or(false)
            }),
            _ => true,
        },
        _ => false,
    }
}

fn evaluate_name(op: &ConditionOp, value: &serde_json::Value, name: &str, case_sensitive: bool) -> bool {
    let val_str = match value.as_str() {
        Some(s) => s.to_string(),
        None => return false,
    };

    let (cmp_name, cmp_val) = if case_sensitive {
        (name.to_string(), val_str.clone())
    } else {
        (name.to_lowercase(), val_str.to_lowercase())
    };

    match op {
        ConditionOp::Contains => cmp_name.contains(&cmp_val),
        ConditionOp::StartsWith => cmp_name.starts_with(&cmp_val),
        ConditionOp::EndsWith => cmp_name.ends_with(&cmp_val),
        ConditionOp::Equals | ConditionOp::Is => cmp_name == cmp_val,
        ConditionOp::Matches => Regex::new(&val_str)
            .map(|re| re.is_match(name))
            .unwrap_or(false),
        ConditionOp::Glob => GlobBuilder::new(&val_str)
            .case_insensitive(!case_sensitive)
            .build()
            .ok()
            .and_then(|g| g.compile_matcher().is_match(name).into())
            .unwrap_or(false),
        _ => false,
    }
}

fn evaluate_size(op: &ConditionOp, value: &serde_json::Value, size: u64) -> bool {
    match op {
        ConditionOp::Gt => {
            if let Some(v) = value.as_u64() {
                size > v
            } else if let Some(v) = value.as_f64() {
                size as f64 > v
            } else {
                false
            }
        }
        ConditionOp::Lt => {
            if let Some(v) = value.as_u64() {
                size < v
            } else if let Some(v) = value.as_f64() {
                (size as f64) < v
            } else {
                false
            }
        }
        ConditionOp::Between => {
            if let Some(arr) = value.as_array() {
                if arr.len() == 2 {
                    let low = arr[0].as_u64().unwrap_or(0);
                    let high = arr[1].as_u64().unwrap_or(u64::MAX);
                    size >= low && size <= high
                } else {
                    false
                }
            } else {
                false
            }
        }
        _ => false,
    }
}

fn evaluate_kind(op: &ConditionOp, value: &serde_json::Value, kind: &FileKind) -> bool {
    let kind_str = kind.as_str();
    match op {
        ConditionOp::Is | ConditionOp::Equals => {
            value.as_str().map(|s| s == kind_str).unwrap_or(false)
        }
        ConditionOp::In => {
            if let Some(arr) = value.as_array() {
                arr.iter().any(|v| v.as_str().map(|s| s == kind_str).unwrap_or(false))
            } else {
                false
            }
        }
        _ => false,
    }
}

fn evaluate_source_folder(op: &ConditionOp, value: &serde_json::Value, folder: &str) -> bool {
    match op {
        ConditionOp::Is | ConditionOp::Equals => {
            if let Some(s) = value.as_str() {
                let norm_folder = folder.replace('\\', "/").to_lowercase();
                let norm_val = s.replace('\\', "/").to_lowercase();
                norm_folder == norm_val
            } else {
                false
            }
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::*;

    fn make_meta(name: &str, ext: &str, size: u64) -> FileMeta {
        FileMeta {
            name: name.to_string(),
            extension: ext.to_string(),
            size,
            mtime: "2026-01-01T00:00:00".to_string(),
            kind: extension_to_kind(ext),
            path: format!("/downloads/{}.{}", name, ext),
            source_folder: "/downloads".to_string(),
        }
    }

    fn make_rule(name: &str, condition: Condition, priority: i32) -> Rule {
        Rule {
            id: Some(1),
            name: name.to_string(),
            enabled: true,
            priority,
            trigger: TriggerType::Arrival,
            condition,
            stop_after: true,
            scope_folder: None,
            actions: vec![RuleAction {
                id: None,
                rule_id: None,
                position: 0,
                action_type: ActionType::Move,
                params: ActionParams {
                    destination: Some("/documents".to_string()),
                    pattern: None,
                    on_conflict: None,
                },
            }],
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn test_extension_is() {
        let meta = make_meta("report", "pdf", 1024);
        let condition = Condition::Leaf(ConditionLeaf {
            field: ConditionField::Extension,
            op: ConditionOp::Is,
            value: serde_json::json!("pdf"),
            case_sensitive: None,
        });
        let rule = make_rule("PDF rule", condition, 1);
        let result = evaluate(&meta, &[rule], &TriggerType::Arrival);
        assert!(result.is_some());
    }

    #[test]
    fn test_extension_in() {
        let meta = make_meta("photo", "jpg", 2048);
        let condition = Condition::Leaf(ConditionLeaf {
            field: ConditionField::Extension,
            op: ConditionOp::In,
            value: serde_json::json!(["jpg", "png", "gif"]),
            case_sensitive: None,
        });
        let rule = make_rule("Image rule", condition, 1);
        let result = evaluate(&meta, &[rule], &TriggerType::Arrival);
        assert!(result.is_some());
    }

    #[test]
    fn test_name_contains() {
        let meta = make_meta("assignment_cs101", "pdf", 512);
        let condition = Condition::Leaf(ConditionLeaf {
            field: ConditionField::Name,
            op: ConditionOp::Contains,
            value: serde_json::json!("assignment"),
            case_sensitive: None,
        });
        let rule = make_rule("Assignment rule", condition, 1);
        let result = evaluate(&meta, &[rule], &TriggerType::Arrival);
        assert!(result.is_some());
    }

    #[test]
    fn test_and_group() {
        let meta = make_meta("report", "pdf", 5_000_000);
        let condition = Condition::Group {
            all: Some(vec![
                Condition::Leaf(ConditionLeaf {
                    field: ConditionField::Extension,
                    op: ConditionOp::Is,
                    value: serde_json::json!("pdf"),
                    case_sensitive: None,
                }),
                Condition::Leaf(ConditionLeaf {
                    field: ConditionField::Size,
                    op: ConditionOp::Gt,
                    value: serde_json::json!(1_000_000),
                    case_sensitive: None,
                }),
            ]),
            any: None,
        };
        let rule = make_rule("Large PDF", condition, 1);
        let result = evaluate(&meta, &[rule], &TriggerType::Arrival);
        assert!(result.is_some());
    }

    #[test]
    fn test_priority_ordering() {
        let meta = make_meta("report", "pdf", 1024);
        let condition = Condition::Leaf(ConditionLeaf {
            field: ConditionField::Extension,
            op: ConditionOp::Is,
            value: serde_json::json!("pdf"),
            case_sensitive: None,
        });
        let mut rule_low = make_rule("Low priority", condition.clone(), 10);
        rule_low.id = Some(1);
        let mut rule_high = make_rule("High priority", condition, 1);
        rule_high.id = Some(2);
        let result = evaluate(&meta, &[rule_low, rule_high], &TriggerType::Arrival);
        assert!(result.is_some());
        assert_eq!(result.unwrap().rule.name, "High priority");
    }

    #[test]
    fn test_no_match() {
        let meta = make_meta("video", "mp4", 1024);
        let condition = Condition::Leaf(ConditionLeaf {
            field: ConditionField::Extension,
            op: ConditionOp::Is,
            value: serde_json::json!("pdf"),
            case_sensitive: None,
        });
        let rule = make_rule("PDF only", condition, 1);
        let result = evaluate(&meta, &[rule], &TriggerType::Arrival);
        assert!(result.is_none());
    }
}

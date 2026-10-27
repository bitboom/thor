//! Preserve interrupted output without inventing completion or remote rollback.
use crate::{runtime_persistence::RuntimeWriteKind, service::ConversationService};
use aionui_common::{ErrorChain, now_ms};
use aionui_db::{MessageRowUpdate, models::MessageRow};
use serde_json::{Value, json};
use tracing::{info, warn};

const NOTICE: &str = "Thor restarted before this work had a durably confirmed completion. Saved output may be incomplete. A tool or remote operation may already have taken effect; its outcome is unknown. Inspect the saved result and current external state before explicitly continuing. Thor has not replayed this work or confirmed cancellation.";

fn recovery_metadata(row: &MessageRow) -> Value {
    let prior_turn_id = serde_json::from_str::<Value>(&row.content).ok().and_then(|value| {
        value
            .get("thor_turn_intent")?
            .get("turn_id")?
            .as_str()
            .map(str::to_owned)
    });
    json!({ "state": "interrupted", "source": "core_restart", "remote_outcome": "unknown",
        "requires_explicit_resume": true, "automatic_replay": false,
        "prior_message_id": row.id, "prior_msg_id": row.msg_id, "prior_backend_turn_id": row.backend_turn_id,
        "prior_turn_id": prior_turn_id })
}

fn interrupted_content(row: &MessageRow) -> String {
    let recovery = recovery_metadata(row);
    let mut value: Value = serde_json::from_str(&row.content).unwrap_or_else(|_| json!({ "content": row.content }));
    if row.r#type == "tool_group"
        && let Some(entries) = value.as_array_mut()
    {
        for entry in entries {
            if !matches!(
                entry.get("status").and_then(Value::as_str),
                Some("Success" | "Error" | "Canceled")
            ) {
                entry["status"] = json!("Error");
                entry["error"] = json!("Interrupted; remote outcome unknown. Inspect before continuing.");
                entry["thor_recovery"] = recovery.clone();
            }
        }
        return value.to_string();
    }
    if !value.is_object() {
        value = json!({ "content": value });
    }
    if row.r#type == "tool_call"
        && !matches!(
            value.get("status").and_then(Value::as_str),
            Some("completed" | "error" | "canceled")
        )
    {
        value["status"] = json!("error");
        value["error"] = json!("Interrupted; remote outcome unknown. Inspect before continuing.");
    }
    if row.r#type == "acp_tool_call"
        && value.get("update").is_some_and(Value::is_object)
        && !matches!(
            value["update"].get("status").and_then(Value::as_str),
            Some("completed" | "failed")
        )
    {
        value["update"]["status"] = json!("failed");
    }
    value["thor_recovery"] = recovery;
    if value.get("thor_turn_intent").is_some_and(Value::is_object) {
        value["thor_turn_intent"]["state"] = json!("interrupted");
    }
    value.to_string()
}

impl ConversationService {
    pub async fn recover_stale_runtime_state_on_startup(&self) {
        let rows = match self.conversation_repo().list_stale_runtime_messages().await {
            Ok(rows) => rows,
            Err(error) => {
                warn!(error = %ErrorChain(&error), "could not query interrupted runtime messages");
                return;
            }
        };
        let mut recovered = 0usize;
        for stale in rows {
            let row = stale.message;
            if !self
                .runtime_persistence()
                .allows(&row.conversation_id, RuntimeWriteKind::StartupRecovery)
            {
                continue;
            }
            // Stable notice id makes a crash during recovery retryable. Store
            // it first: a failed second write must not erase interruption evidence.
            let notice = MessageRow {
                id: format!("thor-recovery-{}", row.id),
                conversation_id: row.conversation_id.clone(),
                msg_id: None,
                r#type: "tips".into(),
                content: json!({ "content": NOTICE, "type": "warning",
                    "code": "THOR_WORK_INTERRUPTED", "recovery": recovery_metadata(&row) })
                .to_string(),
                position: Some("center".into()),
                status: Some("error".into()),
                hidden: false,
                created_at: now_ms(),
                backend_turn_id: row.backend_turn_id.clone(),
            };
            if let Err(error) = self.conversation_repo().upsert_message(&stale.user_id, &notice).await {
                warn!(error = %ErrorChain(&error), "could not persist interruption notice");
                continue;
            }
            let empty = serde_json::from_str::<Value>(&row.content)
                .ok()
                .and_then(|value| {
                    value
                        .get("content")
                        .and_then(Value::as_str)
                        .map(|text| text.trim().is_empty())
                })
                .unwrap_or(false);
            let update = MessageRowUpdate {
                content: Some(interrupted_content(&row)),
                status: Some(Some(
                    if row.position.as_deref() == Some("right") {
                        "finish"
                    } else {
                        "error"
                    }
                    .into(),
                )),
                hidden: Some(empty && matches!(row.r#type.as_str(), "text" | "thinking")),
            };
            match self
                .conversation_repo()
                .update_message(&stale.user_id, &row.conversation_id, &row.id, &update)
                .await
            {
                Ok(()) => {
                    recovered += 1;
                }
                Err(error) => warn!(error = %ErrorChain(&error), "could not mark runtime message interrupted"),
            }
        }
        if recovered > 0 {
            info!(
                recovered,
                "startup recovery recorded interrupted work; no replay attempted"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(kind: &str, content: Value) -> MessageRow {
        MessageRow {
            id: "prior-row".into(),
            conversation_id: "conv".into(),
            msg_id: Some("prior-msg".into()),
            r#type: kind.into(),
            content: content.to_string(),
            position: Some("left".into()),
            status: Some("work".into()),
            hidden: false,
            created_at: 1,
            backend_turn_id: Some("prior-turn".into()),
        }
    }
    #[test]
    fn preserves_partial_text_and_records_interruption_context() {
        let output: Value =
            serde_json::from_str(&interrupted_content(&row("text", json!({"content":"partial output"})))).unwrap();
        assert_eq!(output["content"], "partial output");
        assert_eq!(output["thor_recovery"]["state"], "interrupted");
        assert_eq!(output["thor_recovery"]["prior_backend_turn_id"], "prior-turn");
        assert_eq!(output["thor_recovery"]["automatic_replay"], false);
    }
    #[test]
    fn executing_tools_become_errors_with_unknown_outcome_not_canceled() {
        let output: Value = serde_json::from_str(&interrupted_content(&row(
            "tool_call",
            json!({"call_id":"op-1","status":"running"}),
        )))
        .unwrap();
        assert_eq!(output["status"], "error");
        assert_eq!(output["call_id"], "op-1");
        assert_eq!(output["thor_recovery"]["remote_outcome"], "unknown");
        let group: Value = serde_json::from_str(&interrupted_content(&row(
            "tool_group",
            json!([
            {"call_id":"op-1","status":"Executing"}, {"call_id":"op-2","status":"Success"}]),
        )))
        .unwrap();
        assert_eq!(group[0]["status"], "Error");
        assert_eq!(group[0]["thor_recovery"]["remote_outcome"], "unknown");
        assert_eq!(group[1]["status"], "Success");
        let preserved: Value = serde_json::from_str(&interrupted_content(&row(
            "tool_call",
            json!({"call_id":"op-2","status":"completed","output":"saved result"}),
        )))
        .unwrap();
        assert_eq!(preserved["status"], "completed");
        assert_eq!(preserved["output"], "saved result");
    }
}

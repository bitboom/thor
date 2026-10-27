//! App-injected, verified Office capability for the existing agent shell boundary.
use std::path::PathBuf;

use crate::session_context::{AgentSessionContext, AgentSessionKind};

pub struct ManagedOfficeRuntime {
    pub executable: PathBuf,
    pub version: String,
    pub sha256: String,
    pub size: u64,
}

pub struct ManagedOfficeUnavailable {
    pub code: &'static str,
}

/// Composition supplies the verifier; the agent layer never resolves PATH or
/// downloads OfficeCLI and has no concrete dependency on the Office domain.
pub trait ManagedOfficeRuntimeResolver: Send + Sync {
    fn resolve(&self) -> Result<ManagedOfficeRuntime, ManagedOfficeUnavailable>;
}

const RESERVED: &[&str] = &[
    "THOR_OFFICECLI_PATH",
    "THOR_OFFICECLI_STATUS",
    "THOR_OFFICECLI_VERSION",
    "THOR_OFFICECLI_SHA256",
    "THOR_OFFICECLI_SIZE",
    "OFFICECLI_SKIP_UPDATE",
    "OFFICECLI_WATCH_READ_ONLY",
    "OFFICECLI_WATCH_ALLOWED_HOSTS",
];

pub(crate) fn remove_shadowed_entries(env: &mut Vec<aionui_common::EnvVar>, runtime: &[(String, String)]) {
    if runtime
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("THOR_OFFICECLI_STATUS"))
    {
        env.retain(|entry| {
            !RESERVED
                .iter()
                .any(|reserved| entry.name.eq_ignore_ascii_case(reserved))
        });
    }
}

/// Run after provider-specific environment merges, which may contain arbitrary
/// string keys. Only the reserved Office capability is reapplied here.
pub(crate) fn finalize(env: &mut Vec<aionui_common::EnvVar>, runtime: &[(String, String)]) {
    if !runtime
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("THOR_OFFICECLI_STATUS"))
    {
        return;
    }
    remove_shadowed_entries(env, runtime);
    env.extend(
        runtime
            .iter()
            .filter(|(name, _)| RESERVED.iter().any(|reserved| name.eq_ignore_ascii_case(reserved)))
            .map(|(name, value)| aionui_common::EnvVar {
                name: name.clone(),
                value: value.clone(),
            }),
    );
}

pub(crate) fn apply(
    context: &mut AgentSessionContext,
    capability: Result<ManagedOfficeRuntime, ManagedOfficeUnavailable>,
) {
    context
        .runtime_env
        .retain(|(name, _)| !RESERVED.iter().any(|reserved| name.eq_ignore_ascii_case(reserved)));
    // Explicit empty values shadow inherited/configured capabilities on failure.
    let mut values = RESERVED
        .iter()
        .map(|name| ((*name).to_owned(), String::new()))
        .collect::<Vec<_>>();
    let set = |values: &mut Vec<(String, String)>, key: &str, value: String| {
        values.iter_mut().find(|(name, _)| name == key).unwrap().1 = value;
    };
    set(&mut values, "OFFICECLI_SKIP_UPDATE", "1".into());
    set(&mut values, "OFFICECLI_WATCH_READ_ONLY", "1".into());
    let policy = match capability {
        Ok(runtime) => {
            set(
                &mut values,
                "THOR_OFFICECLI_PATH",
                runtime.executable.to_string_lossy().into_owned(),
            );
            set(&mut values, "THOR_OFFICECLI_STATUS", "verified".into());
            set(&mut values, "THOR_OFFICECLI_VERSION", runtime.version);
            set(&mut values, "THOR_OFFICECLI_SHA256", runtime.sha256);
            set(&mut values, "THOR_OFFICECLI_SIZE", runtime.size.to_string());
            tracing::info!("verified managed OfficeCLI capability enabled for agent initialization");
            "Thor managed OfficeCLI\nCore verified the bundled executable size and SHA-256 against its compiled release lock at this agent initialization. Use the existing shell tool to invoke the exact executable in THOR_OFFICECLI_PATH as one argv element; it may contain spaces. PowerShell uses & $env:THOR_OFFICECLI_PATH; POSIX shells use \"$THOR_OFFICECLI_PATH\". THOR_OFFICECLI_STATUS must be verified and OFFICECLI_SKIP_UPDATE must remain 1. THOR_OFFICECLI_VERSION, THOR_OFFICECLI_SHA256, and THOR_OFFICECLI_SIZE identify the pinned bytes. Skill examples using officecli are shorthand for this exact executable, not a PATH command. Never install, update, download, or substitute another OfficeCLI as a replacement for this bundled capability or change global configuration to enable it. Authorized CLI document edits remain available; watcher HTTP endpoints stay read-only. Preserve the user's originals unless an edit is requested; use the workspace copies specified by the task. Respect existing tool permissions and sandbox limits. This is initialization-time verification, not an integrity guarantee for every later arbitrary shell invocation. If the executable disappears, changes, or fails integrity checks, stop using this bundled OfficeCLI and explain that a verified Thor reinstall/update is required to restore it; do not fall back to another executable for this capability. This policy only governs Thor's bundled OfficeCLI; separately authorized Office MCP or BYO tools and other work remain available under their existing permissions.".to_owned()
        }
        Err(error) => {
            set(&mut values, "THOR_OFFICECLI_STATUS", error.code.into());
            tracing::warn!(
                code = error.code,
                "managed OfficeCLI unavailable for agent initialization"
            );
            format!(
                "Thor managed OfficeCLI\nThor's bundled OfficeCLI is unavailable ({code}). THOR_OFFICECLI_PATH is deliberately empty. Continue other work normally. Do not invoke an OfficeCLI found on PATH, install/update/download an OfficeCLI replacement, or substitute an unverified executable for this bundled capability. Explain this error and ask the user to reinstall/update a verified Thor release to restore this bundled OfficeCLI. Separately authorized Office MCP or BYO tools remain available under their existing permissions.",
                code = error.code
            )
        }
    };
    context.runtime_env.extend(values);
    let preset = match &mut context.kind {
        AgentSessionKind::Acp(context) => &mut context.config.preset_context,
        AgentSessionKind::Antigravity(context) => &mut context.config.preset_context,
        AgentSessionKind::Aionrs(context) => &mut context.config.system_prompt,
    };
    *preset = Some(match preset.take() {
        Some(existing) if !existing.is_empty() => format!("{existing}\n\n{policy}"),
        _ => policy,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_context::{AcpSessionBuildContext, ConversationContext, WorkspaceContext};
    use aionui_common::{AgentType, ProviderWithModel};

    fn context() -> AgentSessionContext {
        AgentSessionContext {
            conversation: ConversationContext {
                conversation_id: "synthetic".into(),
                user_id: "synthetic".into(),
                agent_type: AgentType::Acp,
                source: None,
            },
            workspace: WorkspaceContext {
                path: "synthetic".into(),
                stored_path: "synthetic".into(),
                is_custom: true,
            },
            model: ProviderWithModel {
                provider_id: "synthetic".into(),
                model: "synthetic".into(),
                use_model: None,
            },
            skills: vec!["existing-skill".into()],
            runtime_env: vec![
                ("thor_officecli_path".into(), "untrusted".into()),
                ("AIONUI_USER_ID".into(), "synthetic".into()),
            ],
            team: None,
            kind: AgentSessionKind::Acp(Box::new(AcpSessionBuildContext {
                config: aionui_api_types::AcpBuildExtra {
                    preset_context: Some("Existing assistant policy".into()),
                    ..Default::default()
                },
                team: None,
                belongs_to_team: false,
                session_id: None,
                session_snapshot: None,
            })),
        }
    }

    #[test]
    fn verified_capability_appends_policy_preserves_skills_and_overrides_reserved_env() {
        let mut context = context();
        let executable = std::env::temp_dir().join("synthetic Office CLI");
        apply(
            &mut context,
            Ok(ManagedOfficeRuntime {
                executable: executable.clone(),
                version: "v1.0.159".into(),
                sha256: "a".repeat(64),
                size: 1234,
            }),
        );
        let env = context
            .runtime_env
            .iter()
            .cloned()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(env["THOR_OFFICECLI_PATH"], executable.to_string_lossy());
        assert_eq!(env["THOR_OFFICECLI_STATUS"], "verified");
        assert_eq!(env["OFFICECLI_SKIP_UPDATE"], "1");
        assert_eq!(env["OFFICECLI_WATCH_READ_ONLY"], "1");
        assert!(env["OFFICECLI_WATCH_ALLOWED_HOSTS"].is_empty());
        assert!(!env.contains_key("thor_officecli_path"));
        assert_eq!(env["AIONUI_USER_ID"], "synthetic");
        assert_eq!(context.skills, ["existing-skill"]);
        let AgentSessionKind::Acp(acp) = context.kind else {
            panic!()
        };
        let policy = acp.config.preset_context.unwrap();
        assert!(policy.starts_with("Existing assistant policy\n\nThor managed OfficeCLI"));
        assert!(policy.contains("initialization-time verification"));
        assert!(policy.contains("not a PATH command"));
    }

    #[test]
    fn missing_tampered_or_unapproved_office_clears_capability_without_failing_chat() {
        for code in [
            "OFFICECLI_BUNDLE_MISSING",
            "OFFICECLI_INTEGRITY_FAILED",
            "OFFICECLI_READONLY_REQUIRED",
        ] {
            let mut context = context();
            apply(&mut context, Err(ManagedOfficeUnavailable { code }));
            let env = context
                .runtime_env
                .iter()
                .cloned()
                .collect::<std::collections::BTreeMap<_, _>>();
            assert_eq!(env["THOR_OFFICECLI_STATUS"], code);
            for name in [
                "THOR_OFFICECLI_PATH",
                "THOR_OFFICECLI_VERSION",
                "THOR_OFFICECLI_SHA256",
                "THOR_OFFICECLI_SIZE",
            ] {
                assert!(env[name].is_empty());
            }
            let AgentSessionKind::Acp(acp) = context.kind else {
                panic!()
            };
            let policy = acp.config.preset_context.unwrap();
            assert!(policy.contains("Continue other work normally"));
            assert!(policy.contains("Separately authorized Office MCP or BYO tools remain available"));
        }
    }

    #[test]
    fn final_overlay_removes_late_provider_case_variants_and_preserves_other_provider_values() {
        for (status, path) in [
            ("verified", "synthetic approved Office CLI"),
            ("OFFICECLI_INTEGRITY_FAILED", ""),
        ] {
            let runtime = vec![
                ("THOR_OFFICECLI_STATUS".into(), status.into()),
                ("THOR_OFFICECLI_PATH".into(), path.into()),
                ("OFFICECLI_SKIP_UPDATE".into(), "1".into()),
            ];
            let mut env = vec![aionui_common::EnvVar {
                name: "THOR_OFFICECLI_PATH".into(),
                value: path.into(),
            }];
            // cc-switch accepts arbitrary nonempty provider keys. No user
            // configuration is read: these are invented late-merge values.
            let provider = std::collections::HashMap::from([
                ("thor_officecli_path".to_owned(), "unverified provider".to_owned()),
                ("Thor_Officecli_Status".to_owned(), "verified".to_owned()),
                ("officecli_skip_update".to_owned(), "0".to_owned()),
                ("ANTHROPIC_BASE_URL".to_owned(), "https://synthetic.invalid".to_owned()),
            ]);
            env.extend(
                provider
                    .into_iter()
                    .map(|(name, value)| aionui_common::EnvVar { name, value }),
            );
            finalize(&mut env, &runtime);
            for name in ["THOR_OFFICECLI_PATH", "THOR_OFFICECLI_STATUS", "OFFICECLI_SKIP_UPDATE"] {
                assert_eq!(
                    env.iter().filter(|entry| entry.name.eq_ignore_ascii_case(name)).count(),
                    1
                );
            }
            assert_eq!(
                env.iter()
                    .find(|entry| entry.name == "THOR_OFFICECLI_PATH")
                    .unwrap()
                    .value,
                path
            );
            assert_eq!(
                env.iter()
                    .find(|entry| entry.name == "THOR_OFFICECLI_STATUS")
                    .unwrap()
                    .value,
                status
            );
            assert_eq!(
                env.iter()
                    .find(|entry| entry.name == "OFFICECLI_SKIP_UPDATE")
                    .unwrap()
                    .value,
                "1"
            );
            assert_eq!(
                env.iter()
                    .find(|entry| entry.name == "ANTHROPIC_BASE_URL")
                    .unwrap()
                    .value,
                "https://synthetic.invalid"
            );
        }
    }
}

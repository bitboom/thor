//! Composition adapter: the Office domain owns the compiled-lock verifier.
use aionui_ai_agent::managed_office_runtime::{
    ManagedOfficeRuntime, ManagedOfficeRuntimeResolver, ManagedOfficeUnavailable,
};

pub(crate) struct BundledAgentOffice;

impl ManagedOfficeRuntimeResolver for BundledAgentOffice {
    fn resolve(&self) -> Result<ManagedOfficeRuntime, ManagedOfficeUnavailable> {
        aionui_office::resolve_agent_officecli()
            .map(|runtime| ManagedOfficeRuntime {
                executable: runtime.executable,
                version: runtime.version,
                sha256: runtime.sha256,
                size: runtime.size,
            })
            .map_err(|error| ManagedOfficeUnavailable {
                code: match error {
                    aionui_office::OfficeError::RuntimePolicy { code, .. } => code,
                    _ => "OFFICECLI_UNAVAILABLE",
                },
            })
    }
}

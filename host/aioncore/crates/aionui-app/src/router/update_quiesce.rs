#![allow(clippy::disallowed_types)]
//! Atomic desktop update handoff; never cancels active work.
use aionui_ai_agent::IWorkerTaskManager;
use aionui_api_types::{ApiResponse, UpdateReservationRequest, UpdateReservationResponse};
use aionui_common::{ApiError, ConversationStatus};
use aionui_conversation::runtime_state::ConversationRuntimeStateService;
use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct UpdateQuiesceState {
    pub runtime: Arc<ConversationRuntimeStateService>,
    pub tasks: Arc<dyn IWorkerTaskManager>,
    pub local: bool,
}

pub(super) fn routes(state: UpdateQuiesceState) -> Router {
    Router::new()
        .route("/api/system/update/quiesce", post(reserve))
        .route("/api/system/update/release", post(release))
        .with_state(state)
}

fn validate(state: &UpdateQuiesceState, request: &UpdateReservationRequest) -> Result<(), ApiError> {
    if !state.local {
        return Err(ApiError::Forbidden(
            "Desktop update handoff requires the private local channel".into(),
        ));
    }
    if uuid::Uuid::parse_str(&request.reservation_id).is_err() {
        return Err(ApiError::BadRequest("Invalid update reservation".into()));
    }
    Ok(())
}

async fn reserve(
    State(state): State<UpdateQuiesceState>,
    Json(request): Json<UpdateReservationRequest>,
) -> Result<Json<ApiResponse<UpdateReservationResponse>>, ApiError> {
    validate(&state, &request)?;
    state.runtime.reserve_update(&request.reservation_id).map_err(|code| {
        ApiError::coded(
            StatusCode::CONFLICT,
            code,
            if code == "UPDATE_OPEN_RUNTIMES" {
                "Restart Thor, then install before starting new work."
            } else {
                "Update installation requires idle work. Retry after work finishes or cancel the update."
            },
            None::<serde_json::Value>,
        )
    })?;
    let busy = state
        .tasks
        .active_conversation_ids()
        .iter()
        .filter_map(|id| state.tasks.get_task(id))
        .any(|task| {
            task.status() == Some(ConversationStatus::Running)
                || task.live_background_tasks() > 0
                || !task.get_confirmations().is_empty()
        });
    if busy {
        state.runtime.release_update(&request.reservation_id);
        return Err(ApiError::coded(
            StatusCode::CONFLICT,
            "UPDATE_ACTIVE_WORK",
            "Finish or cancel active work before installing the update.",
            None::<serde_json::Value>,
        ));
    }
    if state.tasks.active_count() > 0 {
        state.runtime.release_update(&request.reservation_id);
        return Err(ApiError::coded(
            StatusCode::CONFLICT,
            "UPDATE_OPEN_RUNTIMES",
            "Close agent sessions or restart Thor, then install before starting new work.",
            None::<serde_json::Value>,
        ));
    }
    Ok(Json(ApiResponse::ok(UpdateReservationResponse {
        reservation_id: request.reservation_id,
        reserved: true,
    })))
}

async fn release(
    State(state): State<UpdateQuiesceState>,
    Json(request): Json<UpdateReservationRequest>,
) -> Result<Json<ApiResponse<UpdateReservationResponse>>, ApiError> {
    validate(&state, &request)?;
    if !state.runtime.release_update(&request.reservation_id) {
        return Err(ApiError::Internal("Could not release update reservation".into()));
    }
    Ok(Json(ApiResponse::ok(UpdateReservationResponse {
        reservation_id: request.reservation_id,
        reserved: false,
    })))
}

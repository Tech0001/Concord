//! A second native webview owns popped-out video; the main player sends controls by IPC.
use crate::{db, AppState};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub seconds: f64,
    pub duration: f64,
    pub playing: bool,
    pub rate: f64,
    pub volume: f64,
    pub muted: bool,
    pub ready: bool,
    pub error: String,
}
impl Position {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.seconds.is_finite()
                && self.seconds >= 0.
                && self.duration.is_finite()
                && self.duration >= 0.,
            "Invalid playback position"
        );
        ensure!(
            [0.75, 1., 1.25, 1.5, 1.75, 2.].contains(&self.rate),
            "Invalid playback rate"
        );
        ensure!(
            self.volume.is_finite() && (0. ..=1.).contains(&self.volume),
            "Invalid volume"
        );
        ensure!(self.error.len() <= 1000, "Playback error is too long");
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub token: String,
    pub media: Value,
    pub source: String,
    pub skip_gaps: bool,
    pub position: Position,
}
#[derive(Default)]
pub struct Control {
    pub session: Mutex<Option<Session>>,
    saved: Mutex<f64>,
    return_paused: AtomicBool,
    pub closing: AtomicBool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Command {
    Play,
    Pause,
    Toggle,
    Seek { seconds: f64, play: bool },
    Rate { value: f64 },
    Volume { value: f64 },
    Mute,
    Gaps { value: bool },
}
impl Command {
    fn validate(&self) -> Result<()> {
        match self {
            Self::Seek { seconds, .. } => {
                ensure!(seconds.is_finite() && *seconds >= 0., "Invalid seek")
            }
            Self::Rate { value } => ensure!(
                [0.75, 1., 1.25, 1.5, 1.75, 2.].contains(value),
                "Invalid playback rate"
            ),
            Self::Volume { value } => ensure!(
                value.is_finite() && (0. ..=1.).contains(value),
                "Invalid volume"
            ),
            _ => (),
        }
        Ok(())
    }
}
fn main_only(window: &tauri::WebviewWindow) -> Result<()> {
    ensure!(
        window.label() == "main",
        "Use the main Concord window for this action"
    );
    Ok(())
}
#[tauri::command]
pub fn popout_state(state: State<'_, AppState>) -> Option<Session> {
    state.popout.session.lock().unwrap().clone()
}
#[tauri::command]
pub async fn popout_open(
    window: tauri::WebviewWindow,
    id: String,
    position: Position,
    skip_gaps: bool,
) -> Result<Session, String> {
    crate::work(move || {
        main_only(&window)?;
        position.validate()?;
        let app = window.app_handle();
        let state = app.state::<AppState>();
        let mut lock = state.popout.session.lock().unwrap();
        if let Some(current) = lock.as_ref() {
            ensure!(
                current.media["id"] == id,
                "Return the current pop-out video before opening another one"
            );
            if let Some(w) = app.get_webview_window("popout") {
                w.set_focus()?;
            }
            return Ok(current.clone());
        }
        let media = db::media(&state.root, &id)?;
        ensure!(
            media["kind"] == "video",
            "Pop-out is available for video recordings"
        );
        let path = Path::new(media["path"].as_str().context("No local media file")?)
            .canonicalize()
            .context("Media unavailable. Reconnect its drive or locate the file.")?;
        let source = state.playback.register_for("popout", path);
        let title = media["title"]
            .as_str()
            .unwrap_or("Concord video")
            .to_owned();
        let session = Session {
            token: uuid::Uuid::new_v4().to_string(),
            media,
            source,
            skip_gaps,
            position: Position {
                ready: false,
                error: String::new(),
                ..position
            },
        };
        state.popout.return_paused.store(false, Ordering::SeqCst);
        state.popout.closing.store(false, Ordering::SeqCst);
        *state.popout.saved.lock().unwrap() = session.position.seconds;
        *lock = Some(session.clone());
        drop(lock);
        let built = tauri::WebviewWindowBuilder::new(
            app,
            "popout",
            tauri::WebviewUrl::App("index.html#/popout".into()),
        )
        .title(title)
        .inner_size(720., 480.)
        .min_inner_size(360., 260.)
        .always_on_top(true)
        .build();
        if let Err(e) = built {
            state.popout.session.lock().unwrap().take();
            state.playback.release("popout");
            return Err(e.into());
        }
        app.emit_to("main", "concord-popout-state", &session)?;
        Ok(session)
    })
    .await
}
#[tauri::command]
pub async fn popout_update(
    window: tauri::WebviewWindow,
    token: String,
    position: Position,
) -> Result<(), String> {
    crate::work(move || {
        ensure!(
            window.label() == "popout",
            "Only the pop-out player can update its playback state"
        );
        position.validate()?;
        let app = window.app_handle();
        let state = app.state::<AppState>();
        let mut lock = state.popout.session.lock().unwrap();
        let Some(current) = lock.as_mut().filter(|s| s.token == token) else {
            return Ok(());
        };
        let paused = current.position.playing && !position.playing;
        current.position = position;
        let value = current.clone();
        drop(lock);
        let mut saved = state.popout.saved.lock().unwrap();
        if value.position.ready && (paused || (value.position.seconds - *saved).abs() >= 10.) {
            db::save_position(
                &state.root,
                value.media["id"].as_str().unwrap(),
                value.position.seconds,
            )?;
            *saved = value.position.seconds;
        }
        drop(saved);
        app.emit_to("main", "concord-popout-state", value)?;
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn popout_command(
    window: tauri::WebviewWindow,
    token: String,
    command: Command,
) -> Result<(), String> {
    crate::work(move || {
        main_only(&window)?;
        command.validate()?;
        let state = window.state::<AppState>();
        let mut lock = state.popout.session.lock().unwrap();
        let current = lock
            .as_mut()
            .filter(|s| s.token == token)
            .context("The pop-out video has closed")?;
        ensure!(
            current.position.ready || matches!(command, Command::Pause),
            "The pop-out video is still loading"
        );
        if let Command::Gaps { value } = command { current.skip_gaps = value; }
        window.app_handle().emit_to(
            "popout",
            "concord-popout-command",
            json!({"token":token,"command":command}),
        )?;
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn popout_close(window: tauri::WebviewWindow, resume: bool) -> Result<(), String> {
    crate::work(move || {
        let app = window.app_handle();
        if window.label() == "main" {
            return request_close(app, resume);
        }
        ensure!(window.label() == "popout", "Unknown player window");
        if !resume {
            app.state::<AppState>()
                .popout
                .return_paused
                .store(true, Ordering::SeqCst);
        }
        app.state::<AppState>()
            .popout
            .closing
            .store(true, Ordering::SeqCst);
        if let Some(w) = app.get_webview_window("popout") {
            w.close()?;
        }
        Ok(())
    })
    .await
}
// Ask the decoder for its final time/play state before closing, including the window's X.
// A crashed webview must still be closable, so force close after a bounded wait.
pub fn request_close(app: &tauri::AppHandle, resume: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let current = state.popout.session.lock().unwrap().clone();
    let Some(current) = current else {
        return Ok(());
    };
    if !resume {
        state.popout.return_paused.store(true, Ordering::SeqCst);
    }
    app.emit_to(
        "popout",
        "concord-popout-return",
        json!({"token":current.token,"resume":resume}),
    )?;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let state = app.state::<AppState>();
        let same = state
            .popout
            .session
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|s| s.token == current.token);
        if same {
            state.popout.closing.store(true, Ordering::SeqCst);
            if let Some(w) = app.get_webview_window("popout") {
                let _ = w.close();
            }
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn popout_focus(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::work(move || {
        main_only(&window)?;
        if let Some(w) = window.app_handle().get_webview_window("popout") {
            w.set_focus()?;
        }
        Ok(())
    })
    .await
}
pub fn closed(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let current = state.popout.session.lock().unwrap().take();
    state.playback.release("popout");
    if let Some(mut current) = current {
        if state.popout.return_paused.load(Ordering::SeqCst) {
            current.position.playing = false;
        }
        if let Err(e) = db::save_position(
            &state.root,
            current.media["id"].as_str().unwrap(),
            current.position.seconds,
        ) {
            crate::runtime_log::push("error", &format!("Could not save pop-out position: {e:#}"));
        }
        let _ = app.emit_to("main", "concord-popout-closed", current);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn controls_reject_invalid_positions_rates_and_volume() {
        assert!(Command::Seek {
            seconds: f64::NAN,
            play: false
        }
        .validate()
        .is_err());
        assert!(Command::Seek {
            seconds: -1.,
            play: false
        }
        .validate()
        .is_err());
        assert!(Command::Rate { value: 900. }.validate().is_err());
        assert!(Command::Volume { value: 1.01 }.validate().is_err());
        assert!(Command::Seek {
            seconds: 12.,
            play: true
        }
        .validate()
        .is_ok());
    }
}

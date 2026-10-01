//! Opt-in native-webview regression runner. Compiled only in debug builds.
//! Requires an explicit scratch data root, test script, and recording ID.
use tauri::{Listener, Manager};

pub fn on_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if webview.label() != "main" || payload.event() != tauri::webview::PageLoadEvent::Finished { return; }
    let (Ok(script), Ok(root), Ok(id)) = (
        std::env::var("CONCORD_NEXT_TEST_SCRIPT"),
        std::env::var("CONCORD_NEXT_DATA"),
        std::env::var("CONCORD_NEXT_TEST_RECORDING"),
    ) else { return; };
    let Ok(script) = std::fs::read_to_string(script) else { return; };
    let config = serde_json::json!({ "id": id, "root": root, "aiUrl": std::env::var("CONCORD_NEXT_TEST_AI_URL").ok() });
    let app = webview.app_handle().clone();
    let report = std::path::Path::new(&root).join("native-test-result.json");
    webview.app_handle().once("concord-native-test-result", move |event| {
        let result = serde_json::from_str::<serde_json::Value>(event.payload()).unwrap_or_default();
        let ok = result["ok"] == true;
        let _ = std::fs::write(&report, serde_json::to_vec_pretty(&result).unwrap_or_default());
        app.exit(if ok { 0 } else { 1 });
    });
    let js = format!(r#"(async () => {{
        const config = {config};
        const report = payload => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{ event: 'concord-native-test-result', payload }});
        try {{ const result = await (async () => {{ {script} }})(); await report({{ ok: true, ...result }}); }}
        catch (e) {{ await report({{ ok: false, error: String(e), stack: e.stack, passed: window.__concordSmokePassed || [], alerts: [...document.querySelectorAll(".toast-message")].map(n => n.textContent) }}); }}
    }})()"#);
    let _ = webview.eval(&js);
}

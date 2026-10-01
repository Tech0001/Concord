use super::queue;
use crate::{runtime_log, speech};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub struct Control {
    pub(crate) gate: Mutex<Option<String>>,
    pub speech: Arc<speech::Control>,
    pub closing: AtomicBool,
    pub checking: AtomicBool,
    pub previewing: AtomicBool,
    pub scanner: Arc<speech::Control>,
}
impl Control {
    pub fn new(speech: Arc<speech::Control>) -> Self {
        Self {
            gate: Mutex::new(None),
            speech,
            closing: AtomicBool::new(false),
            checking: AtomicBool::new(false),
            previewing: AtomicBool::new(false),
            scanner: Arc::new(speech::Control::default()),
        }
    }
    pub fn shutdown(&self) {
        let _guard = self.gate.lock().unwrap();
        self.closing.store(true, Ordering::SeqCst);
        self.speech.cancel();
        self.scanner.cancel();
    }
}
pub fn launch(root: PathBuf, runtime: speech::Runtime, control: Arc<Control>) {
    super::sources::monitor(root.clone(), control.clone());
    std::thread::spawn(move || {
        while !control.closing.load(Ordering::SeqCst) {
            let result = (|| -> anyhow::Result<()> {
                let mut active = control.gate.lock().unwrap();
                if control.closing.load(Ordering::SeqCst)
                    || control.previewing.load(Ordering::SeqCst)
                    || control.speech.busy.load(Ordering::SeqCst)
                {
                    return Ok(());
                }
                let Some(row) = queue::claim(&root, queue::tick_time())? else {
                    return Ok(());
                };
                let id = row["id"].as_str().unwrap();
                *active = Some(id.into());
                control.speech.begin();
                drop(active);
                let result = (|| -> anyhow::Result<bool> {
                    let cfg = super::config(&root)?;
                    let path = if row["kind"] == "download" {
                        match super::download::fetch(&root, &control.speech, &row, &cfg)? {
                            super::download::Outcome::File(path) => path,
                            super::download::Outcome::Waiting => return Ok(false),
                        }
                    } else {
                        PathBuf::from(row["path"].as_str().unwrap_or_default())
                    };
                    speech::process_options(
                        &root,
                        &runtime,
                        &control.speech,
                        id,
                        row["media_id"].as_str().unwrap(),
                        &path,
                        &speech::Options {
                            device: row["device"].as_str().unwrap_or("auto"),
                            language: &cfg.speech_language,
                            diarize: row["diarize"] != 0,
                        },
                    )?;
                    Ok(true)
                })();
                let mut active = control.gate.lock().unwrap();
                let saved = match result {
                    Ok(false) if !control.speech.is_cancelled() => {
                        queue::wait_for_live(&root, id, queue::tick_time())
                    }
                    Ok(false) => queue::finish(
                        &root,
                        id,
                        Err(anyhow::anyhow!("Cancelled")),
                        &control,
                        queue::tick_time(),
                    ),
                    other => {
                        queue::finish(&root, id, other.map(|_| ()), &control, queue::tick_time())
                    }
                };
                control.speech.busy.store(false, Ordering::SeqCst);
                *active = None;
                saved
            })();
            if let Err(e) = result {
                runtime_log::push("error", &format!("Processing queue: {e:#}"));
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

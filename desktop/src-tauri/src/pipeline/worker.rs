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
    pub(super) gate: Mutex<Option<String>>,
    pub speech: Arc<speech::Control>,
    pub closing: AtomicBool,
}
impl Control {
    pub fn new(speech: Arc<speech::Control>) -> Self {
        Self {
            gate: Mutex::new(None),
            speech,
            closing: AtomicBool::new(false),
        }
    }
    pub fn shutdown(&self) {
        let _guard = self.gate.lock().unwrap();
        self.closing.store(true, Ordering::SeqCst);
        self.speech.cancel();
    }
}
pub fn launch(root: PathBuf, runtime: speech::Runtime, control: Arc<Control>) {
    std::thread::spawn(move || {
        while !control.closing.load(Ordering::SeqCst) {
            let result = (|| -> anyhow::Result<()> {
                let mut active = control.gate.lock().unwrap();
                if control.closing.load(Ordering::SeqCst)
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
                let result = speech::process(
                    &root,
                    &runtime,
                    &control.speech,
                    id,
                    row["media_id"].as_str().unwrap(),
                    std::path::Path::new(row["path"].as_str().unwrap_or_default()),
                    row["device"].as_str().unwrap_or("auto"),
                );
                let mut active = control.gate.lock().unwrap();
                let saved = queue::finish(&root, id, result, &control, queue::tick_time());
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

//! Text-only Responses API requests for the account's explicitly granted ChatGPT plan.
use super::super::config::Provider;
use super::*;
use std::{collections::HashMap, path::PathBuf, sync::OnceLock};
type Requests = HashMap<(PathBuf, String), HashMap<String, Arc<AtomicBool>>>;
static REQUESTS: OnceLock<Mutex<Requests>> = OnceLock::new();
fn requests() -> &'static Mutex<Requests> {
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}
struct Lease {
    key: (PathBuf, String),
    id: String,
    stop: Arc<AtomicBool>,
}
impl Lease {
    fn new(root: &Path, account: &str) -> Self {
        let value = Self {
            key: (root.into(), account.into()),
            id: uuid::Uuid::new_v4().to_string(),
            stop: Arc::new(AtomicBool::new(false)),
        };
        requests()
            .lock()
            .unwrap()
            .entry(value.key.clone())
            .or_default()
            .insert(value.id.clone(), value.stop.clone());
        value
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut map = requests().lock().unwrap();
        if let Some(active) = map.get_mut(&self.key) {
            active.remove(&self.id);
            if active.is_empty() {
                map.remove(&self.key);
            }
        }
    }
}
pub(super) fn disconnect(root: &Path, id: &str) {
    if let Some(active) = requests().lock().unwrap().get(&(root.into(), id.into())) {
        for stop in active.values() {
            stop.store(true, Ordering::SeqCst);
        }
    }
}
async fn cancelled(stop: &AtomicBool, account: &AtomicBool) {
    while !stop.load(Ordering::SeqCst) && !account.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}
pub fn complete(
    root: &Path,
    p: &Provider,
    messages: &[Value],
    stop: &AtomicBool,
    mut delta: impl FnMut(&str),
) -> Result<String> {
    complete_at(root, p, messages, stop, &Endpoints::get()?, &mut delta)
}
pub(super) fn complete_at(
    root: &Path,
    p: &Provider,
    messages: &[Value],
    stop: &AtomicBool,
    e: &Endpoints,
    mut delta: impl FnMut(&str),
) -> Result<String> {
    ensure!(!stop.load(Ordering::SeqCst), "Response cancelled");
    let lease = Lease::new(root, &p.account_id);
    let token = access_at(root, &p.account_id, e)?;
    let input=messages.iter().map(|m|json!({"role":if m["role"]=="system"{"developer"}else{m["role"].as_str().unwrap_or("user")},"content":m["content"]})).collect::<Vec<_>>();
    let payload = json!({"model":p.model,"input":input,"store":false,"stream":true});
    tokio::runtime::Builder::new_current_thread().enable_all().build()?.block_on(async {
        let b=reqwest::Client::builder().timeout(Duration::from_secs(240)).connect_timeout(Duration::from_secs(12)).redirect(reqwest::redirect::Policy::none());
        let client=if e.api.starts_with("http://127.0.0.1:"){b.no_proxy()}else{b}.build()?;
        let request=client.post(format!("{}/responses",e.api)).bearer_auth(token).json(&payload);
        let mut response=tokio::select!{_=cancelled(stop,&lease.stop)=>anyhow::bail!("Response cancelled"),r=request.send()=>r.map_err(|_|anyhow::anyhow!("Cannot reach ChatGPT; check your connection"))?};
        let status=response.status().as_u16();
        let request_id=response.headers().get("x-request-id").and_then(|s|s.to_str().ok()).filter(|s|s.len()<=100 && s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_')).unwrap_or("unavailable").to_owned();
        if !(200..300).contains(&status){
            let mut data=Vec::new();
            loop{let chunk=tokio::select!{_=cancelled(stop,&lease.stop)=>anyhow::bail!("Response cancelled"),r=response.chunk()=>r.map_err(|_|anyhow::anyhow!("ChatGPT error response was interrupted"))?};let Some(bytes)=chunk else{break};data.extend_from_slice(&bytes);ensure!(data.len()<=2_000_000,"ChatGPT error response is too large");}
            let value=serde_json::from_slice(&data).unwrap_or(Value::Null);anyhow::bail!("{} Request ID: {request_id}",error(status,&value));
        }
        let mut pending=Vec::new();let mut text=String::new();let mut done=false;
        loop {
            let chunk=tokio::select!{_=cancelled(stop,&lease.stop)=>anyhow::bail!("Response cancelled"),r=response.chunk()=>r.map_err(|_|anyhow::anyhow!("ChatGPT response was interrupted"))?};
            let Some(bytes)=chunk else{break};pending.extend_from_slice(&bytes);ensure!(pending.len()<1_000_000,"ChatGPT event is too large");
            while let Some(end)=pending.iter().position(|b|*b==b'\n') {
                let line=String::from_utf8(pending.drain(..=end).collect()).context("Invalid ChatGPT stream encoding")?;
                let Some(data)=line.strip_prefix("data:").map(str::trim).filter(|s|!s.is_empty()) else{continue};
                if data=="[DONE]" {continue;}
                let event:Value=serde_json::from_str(data).context("Invalid ChatGPT stream event")?;
                match event["type"].as_str().unwrap_or("") {
                    "response.output_text.delta" | "response.refusal.delta"=>if let Some(part)=event["delta"].as_str(){text.push_str(part);ensure!(text.len()<=2_000_000,"ChatGPT answer exceeds the size limit");delta(part);},
                    "response.completed"=>{ensure!(event["response"]["status"].as_str().is_none_or(|s|s=="completed"),"ChatGPT response did not complete");done=true;break;},
                    "response.failed"=>anyhow::bail!("{} Request ID: {request_id}",error(status,&json!({"error":event["response"]["error"]}))),
                    "response.incomplete"=>anyhow::bail!("ChatGPT response was incomplete; your previous saved answer is retained. Request ID: {request_id}"),
                    "error"=>anyhow::bail!("{} Request ID: {request_id}",error(status,&json!({"error":event}))),
                    _=>{}
                }
            }
            if done{break;}
        }
        ensure!(!stop.load(Ordering::SeqCst) && !lease.stop.load(Ordering::SeqCst),"Response cancelled");
        ensure!(done,"ChatGPT stream ended before completion; please retry. Request ID: {request_id}");
        ensure!(!text.trim().is_empty(),"ChatGPT returned an empty answer");Ok(text)
    })
}

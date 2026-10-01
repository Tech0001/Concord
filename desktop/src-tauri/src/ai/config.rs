//! Each AI task has its own provider and credential. Secrets never enter the library DB.
use anyhow::{ensure, Context, Result};
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::Mutex,
    time::Duration,
};

static CONFIG_LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    pub enabled: bool,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub account_id: String,
    #[serde(skip_serializing)]
    pub api_key: String,
}
impl Default for Provider {
    fn default() -> Self {
        Self {
            enabled: false,
            kind: "local".into(),
            base_url: "http://127.0.0.1:11434/v1".into(),
            model: String::new(),
            account_id: String::new(),
            api_key: String::new(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub embedding: Provider,
    pub chat: Provider,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            embedding: super::builtin::default_provider(),
            chat: Provider::default(),
        }
    }
}
fn read_unlocked(root: &Path) -> Result<Config> {
    let path = root.join("ai-providers.json");
    if !path.exists() {
        return Ok(Config::default());
    }
    serde_json::from_slice(&fs::read(path)?).context("Cannot read AI settings")
}
pub fn read(root: &Path) -> Result<Config> {
    let _guard = CONFIG_LOCK.lock().unwrap();
    read_unlocked(root)
}
pub fn view(root: &Path) -> Result<Value> {
    let c = read(root)?;
    let expose = |p: &Provider| {
        let mut v = json!(p);
        v["hasKey"] = json!(!p.api_key.is_empty());
        v["local"] = json!(p.kind == "builtin" || p.is_loopback());
        if p.kind == "chatgpt" {
            let connected = super::chatgpt::available(root, &p.account_id);
            v["connected"] = json!(connected);
            v["enabled"] = json!(p.enabled && connected);
        }
        v
    };
    Ok(json!({"embedding":expose(&c.embedding),"chat":expose(&c.chat)}))
}
pub fn save(root: &Path, task: &str, mut provider: Provider, key: Option<String>) -> Result<Value> {
    ensure!(["embedding", "chat"].contains(&task), "Unknown AI task");
    if provider.kind == "builtin" {
        ensure!(
            task == "embedding",
            "Built-in model only supports embeddings"
        );
        // Keep the caller's choice so built-in search can be switched off.
        let enabled = provider.enabled;
        provider = super::builtin::default_provider();
        provider.enabled = enabled;
    }
    if provider.kind == "chatgpt" {ensure!(task == "chat", "ChatGPT sign-in is only available for chat, summaries and tags");}
    let _guard = CONFIG_LOCK.lock().unwrap();
    let mut c = read_unlocked(root)?;
    let old = if task == "embedding" {
        &mut c.embedding
    } else {
        &mut c.chat
    };
    provider.base_url = provider.base_url.trim().trim_end_matches('/').to_owned();
    provider.model = provider.model.trim().to_owned();
    provider.validate(false)?;
    // Never forward an old credential to a different endpoint when switching providers.
    provider.api_key = key
        .unwrap_or_else(|| {
            if old.base_url == provider.base_url && old.kind == provider.kind {
                old.api_key.clone()
            } else {
                String::new()
            }
        })
        .trim()
        .to_owned();
    ensure!(
        !provider.api_key.contains(['\r', '\n']),
        "API key contains a line break"
    );
    if provider.kind == "chatgpt" {provider.api_key.clear();}
    else {provider.account_id.clear();}
    *old = provider;
    let mut value = json!(c);
    value["embedding"]["apiKey"] = json!(c.embedding.api_key);
    value["chat"]["apiKey"] = json!(c.chat.api_key);
    private_write(
        root,
        "ai-providers.json",
        &serde_json::to_vec_pretty(&value)?,
    )?;
    drop(_guard);
    view(root)
}
/// A model suited to the task: embedding providers often list chat models too, and the other way around.
pub fn pick_model(task: &str, models: &[Value]) -> Option<String> {
    let id = |m: &Value| m["id"].as_str().unwrap_or_default().to_owned();
    let embedding = |m: &&Value| m["id"].as_str().unwrap_or_default().to_lowercase().contains("embed");
    let preferred = if task == "embedding" {
        models.iter().find(embedding)
    } else {
        models.iter().find(|m| !embedding(m))
    };
    preferred.or(models.first()).map(id)
}
/// List a provider's models and make one test request, without saving anything. A missing key
/// reuses the saved one only for the same provider and address. A failed test request still
/// returns the model list (with `error`), so another model can be chosen.
pub fn try_provider(root: &Path, task: &str, mut provider: Provider, key: Option<String>) -> Result<Value> {
    ensure!(["embedding", "chat"].contains(&task), "Unknown AI task");
    let saved = read(root)?;
    let old = if task == "embedding" { &saved.embedding } else { &saved.chat };
    provider.base_url = provider.base_url.trim().trim_end_matches('/').to_owned();
    provider.api_key = key.unwrap_or_else(|| {
        if old.kind == provider.kind && old.base_url == provider.base_url {
            old.api_key.clone()
        } else {
            String::new()
        }
    });
    provider.enabled = true;
    provider.validate(false)?;
    let models = if provider.kind == "chatgpt" {
        super::chatgpt::models(root, &provider.account_id)?
    } else {
        provider.models(task)?
    };
    let model = Some(provider.model.trim().to_owned())
        .filter(|m| models.iter().any(|x| x["id"] == m.as_str()))
        .or_else(|| pick_model(task, &models))
        .context("This provider didn't list any models. Check the address, then try again.")?;
    provider.model = model.clone();
    let check = || -> Result<String> {
        if task == "embedding" {
            let width = provider.embed(&provider.client()?, &["Concord connection check".into()])?[0].len();
            Ok(format!("Embedding model ready · {width} dimensions"))
        } else {
            let text = super::chat::complete(
                root,
                &provider,
                &[json!({"role":"user","content":"Reply with OK."})],
                &std::sync::atomic::AtomicBool::new(false),
                |_| {},
            )?;
            Ok(format!("Chat model ready · {}", text.chars().take(80).collect::<String>()))
        }
    };
    Ok(match check() {
        Ok(message) => json!({"models": models, "model": model, "message": message}),
        Err(e) => json!({"models": models, "model": model, "error": format!("{e:#}")}),
    })
}
pub fn private_write(root: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(root)?;
    let tmp = root.join(format!(".{name}-{}", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, root.join(name))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
impl Provider {
    pub fn is_loopback(&self) -> bool {
        url::Url::parse(&self.base_url).ok().is_some_and(|u| {
            matches!(
                u.host_str(),
                Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
            )
        })
    }
    pub fn validate(&self, model_required: bool) -> Result<()> {
        ensure!(
            ["builtin", "local", "openrouter", "custom", "chatgpt"].contains(&self.kind.as_str()),
            "Unknown AI provider"
        );
        if self.kind == "chatgpt" {
            ensure!(self.base_url == super::chatgpt::RESOURCE, "Use the official ChatGPT API endpoint");
            ensure!(!model_required || !self.account_id.is_empty(), "Choose a connected ChatGPT account in Settings");
        }
        let url = url::Url::parse(&self.base_url).context("Enter a valid API base URL")?;
        ensure!(
            ["http", "https"].contains(&url.scheme()) && url.host_str().is_some(),
            "Use an HTTP or HTTPS API URL"
        );
        ensure!(
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "API URL must not contain credentials, query parameters or a fragment"
        );
        ensure!(
            self.kind != "local" || self.is_loopback(),
            "Local AI must use localhost or a loopback address; choose Custom for a network server"
        );
        ensure!(
            self.kind != "openrouter" || self.base_url == "https://openrouter.ai/api/v1",
            "Use the OpenRouter API address"
        );
        ensure!(
            !model_required || (self.enabled && !self.model.is_empty()),
            "Choose and enable a model in Settings first"
        );
        Ok(())
    }
    pub fn signature(&self) -> String {
        if self.kind == "builtin" {
            return "builtin-qwen3-0.6b-q8-chunks-v1".into();
        }
        format!(
            "{:x}",
            Sha256::digest(format!(
                "chunks-v1\n{}\n{}\n{}",
                self.kind, self.base_url, self.model
            ))
        )
    }
    pub fn client(&self) -> Result<Client> {
        self.validate(false)?;
        let builder = Client::builder()
            .timeout(Duration::from_secs(180))
            .connect_timeout(Duration::from_secs(12))
            .redirect(reqwest::redirect::Policy::none());
        Ok(if self.is_loopback() {
            builder.no_proxy()
        } else {
            builder
        }
        .build()?)
    }
    pub fn request(
        &self,
        client: &Client,
        endpoint: &str,
        body: Option<&Value>,
    ) -> Result<Response> {
        let url = format!("{}/{endpoint}", self.base_url);
        let mut req = if let Some(body) = body {
            client.post(url).json(body)
        } else {
            client.get(url)
        };
        if !self.api_key.is_empty() {
            req = req.bearer_auth(&self.api_key);
        }
        let response = req.send().map_err(|e| {
            if e.is_timeout() {
                anyhow::anyhow!("AI provider timed out; check the server or try again")
            } else {
                anyhow::anyhow!("Cannot reach AI provider; check its URL and whether it is running")
            }
        })?;
        if !response.status().is_success() {
            // Provider error bodies can echo prompts and credentials. Keep diagnostics to status.
            anyhow::bail!(
                "AI provider returned HTTP {}. {}",
                response.status().as_u16(),
                match response.status().as_u16() {
                    401 | 403 => "Check the API key and account permissions.",
                    402 => "Check the provider's credits or plan.",
                    404 => "Check the base URL and model name.",
                    429 => "Provider limit reached; try again later.",
                    _ => "Check the selected model and provider's server logs.",
                }
            );
        }
        Ok(response)
    }
    pub fn json(&self, client: &Client, endpoint: &str, body: Option<&Value>) -> Result<Value> {
        let response = self.request(client, endpoint, body)?;
        let mut bytes = Vec::new();
        response
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 32 * 1024 * 1024,
            "Provider response is too large"
        );
        serde_json::from_slice(&bytes).context("AI provider returned invalid JSON")
    }
    pub fn models(&self, task: &str) -> Result<Vec<Value>> {
        ensure!(self.kind != "chatgpt", "Load ChatGPT models through the selected account");
        if self.kind == "builtin" {
            return Ok(vec![
                json!({"id":super::builtin::MODEL,"name":"Built-in Qwen3 Embedding · CPU"}),
            ]);
        }
        let path = if self.kind == "openrouter" && task == "embedding" {
            "embeddings/models"
        } else {
            "models"
        };
        let result = self.json(&self.client()?, path, None)?;
        let mut models = result["data"]
            .as_array()
            .context("Provider did not return a model list")?
            .iter()
            .filter_map(|v| {
                v["id"]
                    .as_str()
                    .map(|id| json!({"id":id,"name":v["name"].as_str().unwrap_or(id)}))
            })
            .collect::<Vec<_>>();
        models.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        Ok(models)
    }
    pub fn embed(&self, client: &Client, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        ensure!(self.kind != "chatgpt", "ChatGPT sign-in cannot be used for embeddings");
        self.validate(true)?;
        let result = self.json(
            client,
            "embeddings",
            Some(&json!({"model":self.model,"input":inputs,"encoding_format":"float"})),
        )?;
        let data = result["data"]
            .as_array()
            .context("Embedding provider did not return vectors")?;
        ensure!(
            data.len() == inputs.len(),
            "Embedding provider returned the wrong number of vectors"
        );
        let mut vectors = vec![None; inputs.len()];
        for (position, item) in data.iter().enumerate() {
            let index = item["index"]
                .as_u64()
                .map(|n| n as usize)
                .unwrap_or(position);
            ensure!(
                index < inputs.len() && vectors[index].is_none(),
                "Invalid embedding response indices"
            );
            let mut v = item["embedding"]
                .as_array()
                .context("Selected model does not produce embeddings")?
                .iter()
                .map(|n| {
                    n.as_f64()
                        .map(|v| v as f32)
                        .context("Invalid embedding value")
                })
                .collect::<Result<Vec<_>>>()?;
            ensure!(
                !v.is_empty() && v.len() <= 16384 && v.iter().all(|n| n.is_finite()),
                "Invalid embedding dimensions or values"
            );
            let norm = v.iter().map(|n| (*n as f64).powi(2)).sum::<f64>().sqrt();
            ensure!(
                norm > 0. && norm.is_finite(),
                "Provider returned an empty embedding"
            );
            for n in &mut v {
                *n = (*n as f64 / norm) as f32;
            }
            vectors[index] = Some(v);
        }
        let vectors = vectors.into_iter().map(Option::unwrap).collect::<Vec<_>>();
        ensure!(
            vectors.iter().all(|v| v.len() == vectors[0].len()),
            "Provider changed embedding dimensions within a batch"
        );
        Ok(vectors)
    }
}

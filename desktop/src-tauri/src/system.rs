//! Desktop integration that has no Tauri plugin in this app.
use anyhow::{Context, Result};
use std::path::Path;

/// Select the file in the user's file manager, or open its folder when selection isn't supported.
pub fn reveal(path: &Path) -> Result<()> {
    let path = path.canonicalize().context("That file is no longer available")?;
    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};
        let uri = url::Url::from_file_path(&path).map_err(|_| anyhow::anyhow!("Invalid file path"))?;
        let selected = Command::new("dbus-send")
            .args([
                "--session",
                "--print-reply",
                "--dest=org.freedesktop.FileManager1",
                "--type=method_call",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
            ])
            .arg(format!("array:string:{}", uri.as_str().replace(',', "%2C")))
            .arg("string:")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !selected {
            let mut child = Command::new("xdg-open")
                .arg(path.parent().unwrap_or(&path))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .context("No file manager is available")?;
            std::thread::spawn(move || { let _ = child.wait(); });
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        anyhow::bail!("Show in folder is not available on this platform yet: {}", path.display())
    }
}

pub fn open_external(input:&str)->Result<()> {
    let url=url::Url::parse(input).context("Invalid link")?;
    anyhow::ensure!(["http","https"].contains(&url.scheme()),"Only web links can be opened in the browser");
    #[cfg(target_os="linux")]
    let mut command=std::process::Command::new("xdg-open");
    #[cfg(target_os="macos")]
    let mut command=std::process::Command::new("open");
    #[cfg(target_os="windows")]
    let mut command={let mut c=std::process::Command::new("rundll32.exe");c.arg("url.dll,FileProtocolHandler");c};
    let mut child=command.arg(url.as_str()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().context("Cannot open the default browser")?;
    std::thread::spawn(move||{let _=child.wait();});Ok(())
}

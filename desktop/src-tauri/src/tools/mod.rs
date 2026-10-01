//! Local media utilities. Capture and extraction keep working when a page is closed.
pub mod extract;
pub mod discover;
mod process;
pub mod recorder;

pub fn private_dir(path: &std::path::Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

// Exercises real IPC connections without opening the user's library or an AI provider.
const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
await invoke("start_library");
await invoke("setup_save", { patch: { completed: true } });
const id = await invoke("ai_create_chat");
await invoke("ai_edit_chat", { id, title: "Database lifetime test", remove: false });
for (let round = 0; round < 20; round++) {
  await Promise.all([
    invoke("overview"),
    invoke("jobs"),
    invoke("pipeline_state"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const backup = await invoke("archive_create_backup", { folder: config.root + "/backups" });
await invoke("archive_validate_backup", { path: backup.path });
return { rounds: 20, conversationId: id, backup: backup.path };

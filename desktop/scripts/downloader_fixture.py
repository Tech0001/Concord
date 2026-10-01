"""Install a synthetic downloader only inside explicitly created native-test libraries."""
import hashlib,json,pathlib,shutil,sqlite3,uuid

def stage(root, tool, version):
    root=pathlib.Path(root)
    assert root.name.startswith('concord-') and root.parent==pathlib.Path('/tmp')
    directory=str(uuid.uuid4())
    dest=root/'download-tools/versions'/directory
    dest.mkdir(parents=True)
    executable=dest/'yt-dlp'
    shutil.copyfile(tool,executable)
    executable.chmod(0o700)
    data=executable.read_bytes()
    (root/'download-tools/active.json').write_text(json.dumps({'directory':directory,'version':version,'bytes':len(data),'hash':hashlib.sha256(data).hexdigest()}))
    with sqlite3.connect(root/'library.db') as db:
        db.execute("INSERT INTO settings VALUES ('downloads.enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'")

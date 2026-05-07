export default function Footer() {
  return (
    <footer className="mt-8 text-center text-gray-600 text-sm">
      <p>Built with youtube-dl and React.js</p>
      <p className="mt-1">© {new Date().getFullYear()} YouTube Downloader</p>
    </footer>
  );
}

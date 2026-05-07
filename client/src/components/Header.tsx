export default function Header() {
  return (
    <header className="text-center mb-8">
      <h1 className="text-3xl font-bold text-[#FF0000] mb-2 flex items-center justify-center">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 mr-2" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
        </svg>
        YouTube Downloader
      </h1>
      <p className="text-gray-600 text-lg">Download YouTube videos in your preferred resolution</p>
    </header>
  );
}

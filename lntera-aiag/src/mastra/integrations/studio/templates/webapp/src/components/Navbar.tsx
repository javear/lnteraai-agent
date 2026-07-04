export function Navbar() {
  return (
    <header className="border-b border-gray-100">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <span className="text-lg font-semibold text-gray-900">Your Business</span>
        <div className="flex gap-6 text-sm text-gray-600">
          <a href="#features" className="hover:text-gray-900">
            Features
          </a>
          <a href="#contact" className="hover:text-gray-900">
            Contact
          </a>
        </div>
      </nav>
    </header>
  );
}

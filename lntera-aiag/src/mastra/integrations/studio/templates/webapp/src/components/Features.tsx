const FEATURES = [
  { title: 'Fast', body: 'Built on Next.js for a quick, reliable experience for your customers.' },
  { title: 'Simple', body: 'Clean and easy to update — just describe what you want changed.' },
  { title: 'Yours', body: 'Fully customizable to match your business and your brand.' },
];

export function Features() {
  return (
    <section id="features" className="border-t border-gray-100 bg-gray-50">
      <div className="mx-auto max-w-5xl px-6 py-20">
        <div className="grid gap-8 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl bg-white p-6 shadow-sm">
              <h3 className="font-semibold text-gray-900">{f.title}</h3>
              <p className="mt-2 text-sm text-gray-600">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

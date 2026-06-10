// Hand-authored Lottie — a rotating, breathing brand mark for the boot splash.
// Bundled as data (not fetched) so it works offline and adds no network dependency.
const ease = { i: { x: [0.42], y: [1] }, o: { x: [0.58], y: [0] } };
const ease3 = { i: { x: [0.42, 0.42, 0.42], y: [1, 1, 1] }, o: { x: [0.58, 0.58, 0.58], y: [0, 0, 0] } };

export const bootAnimation: Record<string, unknown> = {
  v: '5.7.0',
  fr: 60,
  ip: 0,
  op: 90,
  w: 200,
  h: 200,
  nm: 'boot',
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'mark',
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 1, k: [{ t: 0, s: [0], ...ease }, { t: 90, s: [360] }] },
        p: { a: 0, k: [100, 100, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: {
          a: 1,
          k: [
            { t: 0, s: [82, 82, 100], ...ease3 },
            { t: 45, s: [100, 100, 100], ...ease3 },
            { t: 90, s: [82, 82, 100] },
          ],
        },
      },
      ao: 0,
      shapes: [
        {
          ty: 'gr',
          nm: 'g',
          it: [
            { ty: 'rc', d: 1, s: { a: 0, k: [78, 78] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 22 } },
            { ty: 'fl', c: { a: 0, k: [0.388, 0.4, 0.945, 1] }, o: { a: 0, k: 100 }, r: 1 },
            {
              ty: 'tr',
              p: { a: 0, k: [0, 0] },
              a: { a: 0, k: [0, 0] },
              s: { a: 0, k: [100, 100] },
              r: { a: 0, k: 0 },
              o: { a: 0, k: 100 },
            },
          ],
        },
      ],
      ip: 0,
      op: 90,
      st: 0,
      bm: 0,
    },
  ],
};

// Hand-authored Lottie — a green circle pops in and a white check stamps over it.
// Plays once (loop disabled at the call site). Color is brand green, readable on light + dark.
const GREEN = [0.086, 0.639, 0.29, 1];
const WHITE = [1, 1, 1, 1];
const popIn = { i: { x: [0.2, 0.2, 0.2], y: [1, 1, 1] }, o: { x: [0.4, 0.4, 0.4], y: [0, 0, 0] } };
const settle = { i: { x: [0.4, 0.4, 0.4], y: [1, 1, 1] }, o: { x: [0.6, 0.6, 0.6], y: [0, 0, 0] } };
const pop2 = { i: { x: [0.2, 0.2], y: [1, 1] }, o: { x: [0.4, 0.4], y: [0, 0] } };
const settle2 = { i: { x: [0.4, 0.4], y: [1, 1] }, o: { x: [0.6, 0.6], y: [0, 0] } };
const oEase = { i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] } };

export const successAnimation: Record<string, unknown> = {
  v: '5.7.0',
  fr: 60,
  ip: 0,
  op: 75,
  w: 180,
  h: 180,
  nm: 'success',
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'check',
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [90, 90, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [
        {
          ty: 'gr',
          it: [
            {
              ty: 'sh',
              ind: 0,
              ks: {
                a: 0,
                k: {
                  c: false,
                  i: [[0, 0], [0, 0], [0, 0]],
                  o: [[0, 0], [0, 0], [0, 0]],
                  v: [[-26, 2], [-9, 20], [28, -20]],
                },
              },
            },
            { ty: 'st', c: { a: 0, k: WHITE }, o: { a: 0, k: 100 }, w: { a: 0, k: 14 }, lc: 2, lj: 2, ml: 4 },
            {
              ty: 'tr',
              p: { a: 0, k: [0, 0] },
              a: { a: 0, k: [0, 0] },
              s: {
                a: 1,
                k: [
                  { t: 14, s: [0, 0], ...pop2 },
                  { t: 28, s: [112, 112], ...settle2 },
                  { t: 36, s: [100, 100] },
                ],
              },
              r: { a: 0, k: 0 },
              o: { a: 1, k: [{ t: 14, s: [0], ...oEase }, { t: 22, s: [100] }] },
            },
          ],
        },
      ],
      ip: 0,
      op: 75,
      st: 0,
      bm: 0,
    },
    {
      ddd: 0,
      ind: 2,
      ty: 4,
      nm: 'circle',
      sr: 1,
      ks: {
        o: { a: 1, k: [{ t: 0, s: [0], ...oEase }, { t: 10, s: [100] }] },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [90, 90, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: {
          a: 1,
          k: [
            { t: 0, s: [0, 0, 100], ...popIn },
            { t: 16, s: [112, 112, 100], ...settle },
            { t: 26, s: [100, 100, 100] },
          ],
        },
      },
      ao: 0,
      shapes: [
        {
          ty: 'gr',
          it: [
            { ty: 'el', d: 1, s: { a: 0, k: [112, 112] }, p: { a: 0, k: [0, 0] } },
            { ty: 'fl', c: { a: 0, k: GREEN }, o: { a: 0, k: 100 }, r: 1 },
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
      op: 75,
      st: 0,
      bm: 0,
    },
  ],
};

// Hand-authored Lottie — three breathing dots for the chat empty-state hero.
const ORANGE = [0.949, 0.29, 0.094, 1];

function dot(ind: number, cx: number, phase: number) {
  const o1 = { i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] } };
  const s1 = { i: { x: [0.4, 0.4, 0.4], y: [1, 1, 1] }, o: { x: [0.6, 0.6, 0.6], y: [0, 0, 0] } };
  return {
    ddd: 0,
    ind,
    ty: 4,
    nm: `dot${ind}`,
    sr: 1,
    ks: {
      o: {
        a: 1,
        k: [
          { t: phase, s: [45], ...o1 },
          { t: phase + 18, s: [100], ...o1 },
          { t: phase + 37, s: [45] },
        ],
      },
      r: { a: 0, k: 0 },
      p: { a: 0, k: [cx, 100, 0] },
      a: { a: 0, k: [0, 0, 0] },
      s: {
        a: 1,
        k: [
          { t: phase, s: [60, 60, 100], ...s1 },
          { t: phase + 18, s: [100, 100, 100], ...s1 },
          { t: phase + 37, s: [60, 60, 100] },
        ],
      },
    },
    ao: 0,
    shapes: [
      {
        ty: 'gr',
        it: [
          { ty: 'el', d: 1, s: { a: 0, k: [26, 26] }, p: { a: 0, k: [0, 0] } },
          { ty: 'fl', c: { a: 0, k: ORANGE }, o: { a: 0, k: 100 }, r: 1 },
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
  };
}

export const chatEmptyAnimation: Record<string, unknown> = {
  v: '5.7.0',
  fr: 60,
  ip: 0,
  op: 75,
  w: 200,
  h: 200,
  nm: 'chat-empty',
  ddd: 0,
  assets: [],
  layers: [dot(1, 70, 0), dot(2, 100, 12), dot(3, 130, 24)],
};

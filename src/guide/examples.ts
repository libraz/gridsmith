import type { SpecInput } from '../spec/schema.js';

export type Example = { name: string; description: string; spec: SpecInput };

/** Complete specs that pass every rule; the guide serves them and the README gallery renders them. */
export const EXAMPLES: Example[] = [
  {
    name: 'crescent',
    description: 'A crescent cut from one disc by a second disc offset one module up and right.',
    spec: {
      version: 1,
      mode: 'mark',
      grid: { divisions: 4 },
      concept: 'A crescent cut from one disc by a second, offset one module up and right.',
      shapes: [
        { id: 'body', type: 'circle', r: 'R' },
        { id: 'bite', type: 'circle', center: [1, 1], r: 3 },
      ],
      paint: [{ fill: { subtract: ['body', 'bite'] } }],
    },
  },
  {
    name: 'leaf',
    description:
      'A leaf from the lens of two discs, with a tapering midrib and a stem cut by a second pair of larger discs shifted along the same axis.',
    spec: {
      version: 1,
      mode: 'mark',
      grid: { divisions: 4 },
      concept:
        'Two discs of radius R overlap in a leaf; the same pair of radius 2R discs, shifted along the axis, cuts the midrib and draws the stem.',
      shapes: [
        { id: 'cheek_a', type: 'circle', center: [-1.5, 1.5], r: 'R' },
        { id: 'cheek_b', type: 'circle', center: [1.5, -1.5], r: 'R' },
        { id: 'rib_a', type: 'circle', center: [-5, 6], r: 'R*2' },
        { id: 'rib_b', type: 'circle', center: [6, -5], r: 'R*2' },
        { id: 'stem_a', type: 'circle', center: [-8.5, 2.5], r: 'R*2' },
        { id: 'stem_b', type: 'circle', center: [2.5, -8.5], r: 'R*2' },
      ],
      paint: [
        {
          fill: {
            union: [
              {
                subtract: [
                  { intersect: ['cheek_a', 'cheek_b'] },
                  { intersect: ['rib_a', 'rib_b'] },
                ],
              },
              { intersect: ['stem_a', 'stem_b'] },
            ],
          },
        },
      ],
    },
  },
  {
    name: 'taiji',
    description:
      'A disc divided by an S-curve of two half-radius circles, each found as a tangent circle, with a dot in each half.',
    spec: {
      version: 1,
      mode: 'mark',
      grid: { divisions: 4 },
      concept:
        'Two circles of radius R/2 touch the disc and the horizontal axis; the right half of the disc plus the upper circle minus the lower one makes the S.',
      shapes: [
        { id: 'disc', type: 'circle', r: 'R' },
        { id: 'vertical', type: 'line', from: [0, -4], to: [0, 4] },
        { id: 'horizontal', type: 'line', from: [-4, 0], to: [4, 0] },
        { id: 'upper', type: 'tangent_circle', r: 'R/2', to: ['disc', 'horizontal'], near: [0, 2] },
        {
          id: 'lower',
          type: 'tangent_circle',
          r: 'R/2',
          to: ['disc', 'horizontal'],
          near: [0, -2],
        },
        { id: 'upper_dot', type: 'circle', center: 'upper', r: 0.5 },
        { id: 'lower_dot', type: 'circle', center: 'lower', r: 0.5 },
      ],
      paint: [
        {
          fill: {
            union: [
              {
                subtract: [
                  {
                    union: [{ intersect: ['disc', { half: 'vertical', toward: [1, 0] }] }, 'upper'],
                  },
                  'lower',
                  'upper_dot',
                ],
              },
              'lower_dot',
            ],
          },
        },
      ],
    },
  },
  {
    name: 'open-ring',
    description:
      'A ring with a 60 degree gap cut by two lines through the centre, and a dot at the centre.',
    spec: {
      version: 1,
      mode: 'mark',
      grid: { divisions: 4 },
      concept:
        'A ring from two concentric discs, opened by the wedge between two lines at plus and minus 30 degrees, around a centre dot.',
      shapes: [
        { id: 'outer', type: 'circle', r: 'R' },
        { id: 'inner', type: 'circle', r: 3 },
        { id: 'core', type: 'circle', r: 1 },
        { id: 'edge_up', type: 'line', from: [0, 0], to: { on: 'outer', angle: 30 } },
        { id: 'edge_down', type: 'line', from: [0, 0], to: { on: 'outer', angle: -30 } },
      ],
      paint: [
        {
          fill: {
            union: [
              {
                subtract: [
                  'outer',
                  'inner',
                  {
                    intersect: [
                      { half: 'edge_up', toward: [4, 0] },
                      { half: 'edge_down', toward: [4, 0] },
                    ],
                  },
                ],
              },
              'core',
            ],
          },
        },
      ],
    },
  },
  {
    name: 'eye',
    description:
      'A lens from two discs offset along the vertical axis, with a ring-shaped iris cut out and a pupil put back.',
    spec: {
      version: 1,
      mode: 'mark',
      grid: { divisions: 4 },
      shapes: [
        { id: 'upper', type: 'circle', center: [0, -2.5], r: 'R' },
        { id: 'lower', type: 'circle', center: [0, 2.5], r: 'R' },
        { id: 'iris', type: 'circle', r: 1 },
        { id: 'pupil', type: 'circle', r: 0.5 },
      ],
      paint: [
        { fill: { union: [{ subtract: [{ intersect: ['upper', 'lower'] }, 'iris'] }, 'pupil'] } },
      ],
    },
  },
  {
    name: 'whale',
    description:
      'A whale silhouette as one outline through circles: a round head, tangent-circle belly and back tapering to two flukes joined at corners, with an eye cut out and a two-crescent spout.',
    spec: {
      version: 1,
      mode: 'mark',
      grid: { divisions: 8 },
      shapes: [
        { id: 'head', type: 'circle', center: [-3.5, -1], r: 4 },
        { id: 'bay_l', type: 'circle', center: [3, 2.5], r: 1.5 },
        { id: 'bay_r', type: 'circle', center: [7, 2.5], r: 1.5 },
        { id: 'belly', type: 'tangent_circle', r: 8, to: ['head', 'bay_r'], near: [-1, 3] },
        { id: 'back', type: 'tangent_circle', r: 8, to: ['head', 'bay_l'], near: [-5, -5] },
        { id: 'fluke_l', type: 'circle', center: [4, 3], r: 2 },
        { id: 'fluke_r', type: 'circle', center: [6, 3], r: 2 },
        { id: 'eye', type: 'circle', center: [-5, -2], r: 0.5 },
        { id: 'jet_l', type: 'circle', center: [-5, 5], r: 1.5 },
        { id: 'jet_l_cut', type: 'circle', center: [-5.5, 4.5], r: 1.5 },
        { id: 'jet_r', type: 'circle', center: [-2, 5], r: 1.5 },
        { id: 'jet_r_cut', type: 'circle', center: [-1.5, 4.5], r: 1.5 },
        {
          id: 'whale',
          type: 'outline',
          through: [
            'belly',
            { on: 'bay_r', concave: true, corner: [8.2, 3.5] },
            { on: 'fluke_r', corner: [5, 4.7] },
            { on: 'fluke_l', corner: [1.8, 3.5] },
            { on: 'bay_l', concave: true },
            'back',
            'head',
          ],
        },
      ],
      paint: [
        {
          fill: {
            union: [
              { subtract: ['whale', 'eye'] },
              { subtract: ['jet_l', 'jet_l_cut'] },
              { subtract: ['jet_r', 'jet_r_cut'] },
            ],
          },
        },
      ],
    },
  },
  {
    name: 'hexagram-circle',
    description: 'Three concentric circles, a hexagram, and a band of twelve small circles.',
    spec: {
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        { id: 'outer', type: 'circle', r: 'R' },
        { id: 'band', type: 'circle', r: 3.5 },
        { id: 'inner', type: 'circle', r: 3 },
        { id: 'core', type: 'circle', r: 'R/2' },
        { id: 'star', type: 'polygon', in: 'inner', n: 6, step: 2, rotate: 90 },
        { id: 'dot', type: 'circle', center: { on: 'band', angle: 0 }, r: 0.25 },
        { id: 'dots', type: 'repeat', of: ['dot'], n: 12 },
      ],
      paint: [{ stroke: ['outer', 'inner', 'core', 'star', 'dots'], width: 0.125 }],
    },
  },
  {
    name: 'pentagram',
    description:
      'A pentagram whose inner pentagon is inscribed in a circle of radius phi-squared times smaller, framed by a pentagon.',
    spec: {
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        { id: 'outer', type: 'circle', r: 'R' },
        { id: 'ring', type: 'circle', r: 3.5 },
        { id: 'core', type: 'circle', r: 'ring.r/phi2' },
        { id: 'frame', type: 'polygon', in: 'outer', n: 5, rotate: 90 },
        { id: 'star', type: 'polygon', in: 'ring', n: 5, step: 2, rotate: 90 },
        { id: 'inner', type: 'polygon', in: 'core', n: 5, rotate: 270 },
        { id: 'dot', type: 'circle', center: { on: 'ring', angle: 90 }, r: 0.25 },
        { id: 'dots', type: 'repeat', of: ['dot'], n: 5 },
      ],
      paint: [
        { stroke: ['outer', 'frame', 'ring', 'star', 'core', 'inner', 'dots'], width: 0.125 },
      ],
    },
  },
  {
    name: 'sigil-medallions',
    description:
      'Concentric double-line bands, a ring of radial ticks, nested squares and triangles, and medallions that erase the bands behind them, each holding a small star.',
    spec: {
      version: 1,
      mode: 'figure',
      grid: { divisions: 8 },
      shapes: [
        { id: 'a1', type: 'circle', r: 'R' },
        { id: 'a2', type: 'circle', r: 7.75 },
        { id: 't_out', type: 'circle', r: 7.25 },
        { id: 't_in', type: 'circle', r: 6.5 },
        { id: 'c1', type: 'circle', r: 6 },
        { id: 'c2', type: 'circle', r: 5.75 },
        { id: 'd1', type: 'circle', r: 5 },
        { id: 'd2', type: 'circle', r: 4.75 },
        { id: 'sq_a', type: 'circle', r: 4.5 },
        { id: 'sq_b', type: 'circle', r: 'sq_a.r/sqrt2' },
        { id: 'tri_a', type: 'circle', r: 2 },
        { id: 'tri_b', type: 'circle', r: 'tri_a.r/2' },
        { id: 'med', type: 'circle', center: { on: 't_in', angle: 90 }, r: 1.75 },
        { id: 'dmed', type: 'circle', center: { on: 't_in', angle: 45 }, r: 1 },
        {
          id: 'tick_a',
          type: 'line',
          from: { on: 't_out', angle: 0 },
          to: { on: 't_in', angle: 0 },
        },
        {
          id: 'tick_b',
          type: 'line',
          from: { on: 't_out', angle: 7.5 },
          to: { on: 't_in', angle: 7.5 },
        },
        { id: 'ticks_a', type: 'repeat', of: ['tick_a'], n: 24 },
        { id: 'ticks_b', type: 'repeat', of: ['tick_b'], n: 24 },
        { id: 'sq1', type: 'polygon', in: 'sq_a', n: 4 },
        { id: 'sq2', type: 'polygon', in: 'sq_b', n: 4, rotate: 45 },
        { id: 'tri1', type: 'polygon', in: 'tri_a', n: 3, rotate: 90 },
        { id: 'tri2', type: 'polygon', in: 'tri_b', n: 3, rotate: 270 },
        { id: 'star', type: 'polygon', in: 'med', n: 5, step: 2, rotate: 90 },
        { id: 'gem', type: 'polygon', in: 'dmed', n: 4, rotate: 45 },
        { id: 'medals', type: 'repeat', of: ['med', 'dmed'], n: 4 },
        { id: 'emblems', type: 'repeat', of: ['star', 'gem'], n: 4 },
      ],
      paint: [
        {
          stroke: ['a1', 'a2', 't_out', 't_in', 'c1', 'c2', 'd1', 'd2', 'ticks_a', 'ticks_b'],
          width: 0.0625,
        },
        { erase: ['medals'] },
        { stroke: ['medals', 'sq1', 'sq2', 'tri1', 'tri2'], width: 0.125 },
        { stroke: ['emblems'], width: 0.0625 },
      ],
    },
  },
  {
    name: 'crescent-moon',
    description:
      'A crescent outline of two arcs, one on each circle, running between the two points where the circles intersect.',
    spec: {
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        { id: 'moon', type: 'circle', r: 'R' },
        { id: 'bite', type: 'circle', center: [1.5, 0], r: 3.5 },
        { id: 'horn_top', type: 'point', at: { intersect: ['moon', 'bite'], near: [2, 3] } },
        { id: 'horn_low', type: 'point', at: { intersect: ['moon', 'bite'], near: [2, -3] } },
        { id: 'outer_edge', type: 'arc', on: 'moon', from: 'horn_top', to: 'horn_low' },
        { id: 'inner_edge', type: 'arc', on: 'bite', from: 'horn_top', to: 'horn_low' },
        { id: 'planet', type: 'circle', center: [2.25, 0], r: 0.75 },
      ],
      paint: [{ stroke: ['outer_edge', 'inner_edge', 'planet'], width: 0.15625 }],
    },
  },
  {
    name: 'petal-rosette',
    description:
      'Eight petals, each outlined by two arcs between the intersection points of a pair of circles, repeated about the centre.',
    spec: {
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        { id: 'frame', type: 'circle', r: 'R' },
        { id: 'left', type: 'circle', center: [2, 1.5], r: 2.5 },
        { id: 'right', type: 'circle', center: [2, -1.5], r: 2.5 },
        { id: 'base', type: 'point', at: { intersect: ['left', 'right'], near: [0, 0] } },
        { id: 'tip', type: 'point', at: { intersect: ['left', 'right'], near: [4, 0] } },
        { id: 'lower', type: 'arc', on: 'left', from: 'base', to: 'tip' },
        { id: 'upper', type: 'arc', on: 'right', from: 'tip', to: 'base' },
        { id: 'petals', type: 'repeat', of: ['lower', 'upper'], n: 8 },
        { id: 'hub', type: 'circle', r: 1 },
      ],
      paint: [
        { stroke: ['frame', 'hub'], width: 0.09375 },
        { stroke: ['petals'], width: 0.125 },
      ],
    },
  },
  {
    name: 'hexagon-rosette',
    description:
      'Hexagons nested by the same step, each circle touching the edge midpoints of the hexagon outside it and turned 30 degrees.',
    spec: {
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        { id: 'c1', type: 'circle', r: 'R' },
        { id: 'c2', type: 'circle', r: 'c1.r*sqrt3/2' },
        { id: 'c3', type: 'circle', r: 'c2.r*sqrt3/2' },
        { id: 'c4', type: 'circle', r: 'c3.r*sqrt3/2' },
        { id: 'c5', type: 'circle', r: 'c4.r*sqrt3/2' },
        { id: 'h1', type: 'polygon', in: 'c1', n: 6 },
        { id: 'h2', type: 'polygon', in: 'c2', n: 6, rotate: 30 },
        { id: 'h3', type: 'polygon', in: 'c3', n: 6 },
        { id: 'h4', type: 'polygon', in: 'c4', n: 6, rotate: 30 },
        { id: 'h5', type: 'polygon', in: 'c5', n: 6 },
      ],
      paint: [{ stroke: ['c1', 'h1', 'h2', 'h3', 'h4', 'h5', 'c5'], width: 0.0625 }],
    },
  },
];

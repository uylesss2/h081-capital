// Poseidon over the BN254 scalar field in plain BigInt arithmetic: no WASM,
// no ffjavascript, so it runs in any browser. Port of circomlibjs'
// poseidon_opt (the Neptune-style optimised round structure) and verified
// against it in test/circuits/poseidon.test.ts. Constants come from
// poseidon-constants.json, trimmed to the widths the protocol uses.
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface PoseidonConstants {
  C: string[][];
  S: string[][];
  M: string[][][];
  P: string[][][];
}

const N_ROUNDS_F = 8;
const N_ROUNDS_P = [56, 57, 56, 60, 60, 63, 64, 63, 60, 66, 60, 65, 70, 60, 64, 68];

const mod = (a: bigint) => { const r = a % P; return r < 0n ? r + P : r; };
const mul = (a: bigint, b: bigint) => (a * b) % P;
const add = (a: bigint, b: bigint) => { const r = a + b; return r >= P ? r - P : r; };
const pow5 = (a: bigint) => { const a2 = mul(a, a); return mul(a, mul(a2, a2)); };

export function makePoseidon(constants: PoseidonConstants) {
  const cache = new Map<number, { C: bigint[]; S: bigint[]; M: bigint[][]; P: bigint[][] }>();
  const load = (t: number) => {
    let c = cache.get(t);
    if (!c) {
      const i = t - 2;
      if (!constants.C[i]) throw new Error(`no Poseidon constants for t=${t}`);
      c = { C: constants.C[i].map(BigInt), S: constants.S[i].map(BigInt), M: constants.M[i].map((r) => r.map(BigInt)), P: constants.P[i].map((r) => r.map(BigInt)) };
      cache.set(t, c);
    }
    return c;
  };

  return function poseidon(inputs: bigint[]): bigint {
    if (inputs.length < 1 || inputs.length > N_ROUNDS_P.length) throw new Error('bad input count');
    const t = inputs.length + 1;
    const nRoundsP = N_ROUNDS_P[t - 2];
    const { C, S, M, P: Pm } = load(t);
    let state = [0n, ...inputs.map(mod)];
    state = state.map((a, i) => add(a, C[i]));
    const mix = (m: bigint[][]) => state.map((_, i) => state.reduce((acc, a, j) => add(acc, mul(m[j][i], a)), 0n));
    for (let r = 0; r < N_ROUNDS_F / 2 - 1; r++) {
      state = state.map(pow5);
      state = state.map((a, i) => add(a, C[(r + 1) * t + i]));
      state = mix(M);
    }
    state = state.map(pow5);
    state = state.map((a, i) => add(a, C[(N_ROUNDS_F / 2) * t + i]));
    state = mix(Pm);
    for (let r = 0; r < nRoundsP; r++) {
      state[0] = pow5(state[0]);
      state[0] = add(state[0], C[(N_ROUNDS_F / 2 + 1) * t + r]);
      const s0 = state.reduce((acc, a, j) => add(acc, mul(S[(t * 2 - 1) * r + j], a)), 0n);
      for (let k = 1; k < t; k++) state[k] = add(state[k], mul(state[0], S[(t * 2 - 1) * r + t + k - 1]));
      state[0] = s0;
    }
    for (let r = 0; r < N_ROUNDS_F / 2 - 1; r++) {
      state = state.map(pow5);
      state = state.map((a, i) => add(a, C[(N_ROUNDS_F / 2 + 1) * t + nRoundsP + r * t + i]));
      state = mix(M);
    }
    state = state.map(pow5);
    state = mix(M);
    return state[0];
  };
}

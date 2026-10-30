declare module 'circomlibjs' {
  export function buildPoseidon(): Promise<unknown>;
  export const poseidonContract: {
    createCode(nInputs: number): string;
    generateABI(nInputs: number): import('ethers').InterfaceAbi;
  };
}

declare module 'snarkjs' {
  export const groth16: {
    fullProve(input: unknown, wasm: string, zkey: string): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
  };
  export const zKey: {
    newZKey(r1cs: string, ptau: string, out: string): Promise<void>;
    contribute(zkeyIn: string, zkeyOut: string, name: string, entropy: string): Promise<void>;
    exportVerificationKey(zkey: string): Promise<{ nPublic: number }>;
    exportSolidityVerifier(zkey: string, templates: { groth16: string }): Promise<string>;
  };
  // phase 1, used by the ceremony test to make a small local ptau
  export const powersOfTau: {
    newAccumulator(curve: unknown, power: number, out: string): Promise<unknown>;
    contribute(ptauIn: string, ptauOut: string, name: string, entropy: string): Promise<unknown>;
    preparePhase2(ptauIn: string, ptauOut: string): Promise<unknown>;
  };
}

declare module 'ffjavascript' {
  export function getCurveFromName(name: string): Promise<{ terminate(): Promise<void> }>;
}

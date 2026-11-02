# Groth16 trusted setup (phase 2), 2026-10-31

This replaces the earlier single-contribution development keys. It covers all six circuits
(`transact`, `grant`, `spend`, `disclose`, `delegate`, `stream`); the verifying keys the `stipend_pool`
program embeds (`solana/programs/stipend_pool/src/generated/vk.rs`) come from this ceremony.

**Who contributed.** All three contributions to every circuit were made by the H0.81 project team, on one
machine, on 2026-10-31. Nobody outside the team took part. Groth16 phase 2 is sound if at least one
contributor destroyed their randomness; for this round that means you are trusting the project team. We
intend to run a later public round on top of these keys and invite anyone to take part (open an issue on
the repository). The new verifying keys would then be installed through a program upgrade.

## Phase 1

The public Hermez / Polygon powers of tau, `powersOfTau28_hez_final_17.ptau` (2^17 constraints), checked
against the hash published in the snarkjs README. The `circuits/ptau/pot17.ptau` file in this repository is
a local development file and was **not** used.

| | |
|---|---|
| blake2b-512 | `6247a3433948b35fbfae414fa5a9355bfb45f56efa7ab4929e669264a0258976741dfbe3288bfb49828e5df02c2e633df38d2245e30162ae7e3bcca5b8b49345` |
| sha256 | `6b662a324867139fb1a20a324d90b6ff61856dfb23f59326909f14b0e2483ae0` |

## Procedure

Tooling: `scripts/ceremony.mjs` (snarkjs 0.7.5), one independent chain per circuit, the six circuits run in
parallel.

1. `init`: `snarkjs zkey new` from the circuit's r1cs and the ptau (the ptau blake2b is checked at init).
2. Three `contribute` steps per circuit. Each draws 64 fresh bytes from the OS CSPRNG
   (`crypto.randomBytes`); the entropy is held only in memory and is never written to disk or logged, so
   there was no entropy file to delete.
3. Random beacon (`snarkjs zkey beacon`, 2^10 iterations) from a Solana mainnet-beta block hash fetched
   **after** the last contribution had finished (last contribution 2026-10-31T00:41:28Z), with a read-only
   `getLatestBlockhash` call (commitment `finalized`) to `https://api.mainnet-beta.solana.com`:
   - block hash (base58) `HfnPkpVKUZ2enGWZo7zjMh6xCZWNyDetvejnhnMaXW4S`
   - slot `463490557`, block height `441512795`, block time 2026-10-31T00:41:40Z (confirm with `getBlock`)
   - beacon value (the 32 decoded bytes, hex) `f7aa63083f307cb8ec4b548e4a50893cd8248c097a1ebf85bb0675639ea7485b`
4. `ceremony.mjs verify`: re-derives the initial key from r1cs + ptau, checks every contribution and the
   beacon, and checks that the contribution hashes in the key match the transcript. All six: ok.
5. Independent check: `snarkjs zkey verify <r1cs> <ptau> <final zkey>` printed `ZKey Ok!` for all six.
6. The intermediate keys (`*_0000` to `*_0003.zkey`) were deleted; only the final keys were kept.

The transcripts (`ceremony.json`), per-circuit attestations and verifying keys are in
[`docs/ceremony/<circuit>/`](ceremony/).

## Results

Circuits compiled with `npm run circuits:build` (circom2 0.2.22, circomlib 2.0.5); a fresh build of this
commit produces these r1cs files.

| circuit | constraints | public inputs | r1cs sha256 |
|---|---|---|---|
| transact | 27950 | 8 | `a6ca965d2a452a98c6d3721810fc48e20a73fe068bf3609c1f9a128574aedc49` |
| grant | 96685 | 22 | `341adfee4501c8a61e249327640680f73b2d76e8e48f07b620fb890dc8ec047a` |
| spend | 27344 | 15 | `fbde5e7bdf4595efbb4a324501821b4aae4dc7596037d1fdcc83cf38a41d78ce` |
| disclose | 14310 | 6 | `d92f5ac6ac039989a39e560bbf53e0ca51e94c108bafffd36dcb733035e9287b` |
| delegate | 35307 | 9 | `7c57541ff6e3438c2ae72d6540b37c0a7027da7a6118eb008962d3a8853d6449` |
| stream | 14482 | 13 | `fe4567697b1f9802dffca40a0b7891e019d7c394e6e0bb6002e59b3001d69200` |

Final keys:

| circuit | final zkey sha256 | verifying key (`<name>.vkey.json`) sha256 |
|---|---|---|
| transact | `19115cc60b47b8ba71a8bd2ec0eb7d1973801df78d5eee52550c1daca8ca940f` | `ea4def715d6fe7c4dd834ee973f491d80fac913b7c0a10e2a505faa0091259bb` |
| grant | `8c1df0b58d1bdb69a60097479fa49d344af5ccbd8c21d6b625c60eeca1584200` | `dc97feab01ec6a7678a8bafd2f3ad93fc8ed816056e009b50f3baed2575a5b28` |
| spend | `0e5cbe9f896a611717df1c65104f2ea53ee2ae282c3a98837f564a62250651e9` | `f019991fb96969eb5cfd5251f63899e0b273e6992910873413c296f6ac305f88` |
| disclose | `9ac5fc252f76779e07eee9f3e98ce430aabe8ccdb74891c99d338035625c1b24` | `c34de1a64c403bc5f37372efbae8fe9ed82a2afd85f7ab20246d959b3e84b1b4` |
| delegate | `41056c1c7e2030e3229ece87d9eaf3cf9edf353a92b5c56627aaa8e2a725fef9` | `e748f78f4c5296d1e5371cbf79bacd819a4a111160629c0377fbdb74a8f530e0` |
| stream | `f2b821af10ccd92e2d97fded94e44037328b036ecf82162497e34746522f30fb` | `4be743351074631c1ac3a243d4a7471b475f0e1e0cd564f21c4827486c8ade8d` |

`solana/programs/stipend_pool/src/generated/vk.rs`, generated from these verifying keys by
`npm run solana:vk`: sha256 `a325bbb70851a06bd7bd2a8383c78e975ec084de261d6bad2cc954cdedd33d13`.

Contribution hashes, in order (as `snarkjs zkey verify` prints them; the last one is the beacon):

| circuit | # | contribution hash |
|---|---|---|
| transact | 1 | `14dc59a407c5074a7a8a5a5d92ae4260495c9913bb5d039d92259038657c4ea5b2ae2a561a800e605f5ee06f78b880ca794c16dca757c1cf889df508df2c4169` |
| transact | 2 | `0136fd69dcde771c9e7d4be09f30a76ac833a423a3b1565947bf58c74789edd9eb7662b75d34ce60347c0c15060d11bf6634a5e81a1173c6a5d5041e7c8cde59` |
| transact | 3 | `1c01a14447ce70154edf4a43b2f9c854b4a03ec46517f8c273b59caf8cf4a9cc5a7d75e18f985ca6d2b989bb47e003e7690930d769ae4f0d087d45413bb862b5` |
| transact | beacon | `9944c6e519e6d73db202eebe9b904478831c2a24a3283519ec04f16d18dcd15c3af4c7ad6a9be32a6d1ed72550fdc2aef81b954c3378a829c6ac5033df411880` |
| grant | 1 | `6a57b28f1b1f7b58b44d3e8c9636e1ff1e16e74f150ea37bbebdd349eff23d7766e950c65bac96fe497acb3e3d684ee64143579fb3bca872485d77483171d234` |
| grant | 2 | `b0ca685d5f3b1549947e4343614da5aeb4af700c209e07ce6f2a99780c98610722a68f078c76602b9020363c50e9b088a36c3df95d4987f9b8b3724a6c720890` |
| grant | 3 | `5a1e1bb17055b5d33faa7b7a6e2914e2135a51e12aca5875b00c8c182c4c22e101c2c90f05efbb87b1852bff314d37f94f9f37862e1b20689b6c9cea8ba4fed7` |
| grant | beacon | `040af2b57905076d78bb0c6418d97fa92d1b7d45d0958ed38565f19c7b14fd03648efdfeada0939a317d5d4955866e6b4dae764b565652a215a30f731f8d8663` |
| spend | 1 | `71883ffc78d66571b9739e68bf428ad5dc4ee7381405e8c1254cdfe4a46b9127018a17712cf8f232e0a9dfd41b062e4a12c0abe6211a800852ab1d4670723c41` |
| spend | 2 | `14a7916afcf5e1265ef059ddfaba08a03585c81a5b08dde75f5e07569f1d05617510e992602893c39fe0f72c7a201fc5af005f13f413e900c887aecb509416d3` |
| spend | 3 | `f8dc8bcfffafc19092563f06ba7936fdcf0ca20969948a8cf7d9568efb5083a1a09eb93f429d71ccaf0dc96d6a2b6f1efd807e3d3e16d0420b2037867c2ae332` |
| spend | beacon | `683f2fd941e821258e3d8295c7a73d4b0428f5fe1d9c26c62a1f9d5128f2f0c28f69c8ce47d4a076526696ab3ad80503981e6a79d02887c354284e22f567de47` |
| disclose | 1 | `87241815f3e241c698fa3f3ca5c3c5fd74d4940370a1c123e668abecfb307fafa5f41ffce115c283ee2ad056bd654466bcc265489d4cd8cb6f9cdc61fb1288fe` |
| disclose | 2 | `fc0d6351b7751d446aa9563ba0e0ca0be4187b0baea0e8457fe144863457dd059c09ebc8c508fbf5984a3da3dfa06475097d1d868af35e968a404b41387c35cb` |
| disclose | 3 | `36e9e8b9d4c63ee9011a1814c598c1f9c9d9730fb37d1d9b15b5b42b21a776c41693bf3285aebb0a4dc701c0024ad773b6163eb52b29b5b75c2c1d6864c97aba` |
| disclose | beacon | `478a7198e98f08f84d6ab7e19ec85bd34813ed11f1e66de1be0be62cba919d7f83b2792240c376d429a1133eb13837f1d530eef708f898b43bd3d7930f9fbdb0` |
| delegate | 1 | `1a21515889eaf37d5fadf81ee4325ca944b64662d206dc68555e71376b2f12a6ba4250ea1b53856176e8702b1abfe696ea8f8dcc87c46f27fa77c61fa4080505` |
| delegate | 2 | `47ae5aa757ba3d229e02574263e87189eb7d30f1e7ab9ad5956301c8470293efe719b3a7e81253a60e3de48ca239b7699d08e3df882e6d26be3eee8cd797f782` |
| delegate | 3 | `13c61b95aa4f54483884999738c8e5cc4cc8809c9992a8f515d730abc12572349b6f82b4b6c15b652d7e612d4b2f87747ebee22437a8d32a13110c641480dc0a` |
| delegate | beacon | `f9236ba7d2a2b6f62735f8018cf9d20d0b586b59b109de73e607011718ecd32663ff4a503a0239490610852b5ff052fdc72d03fd569b7fb48328819afec58573` |
| stream | 1 | `2e65f1f4f467d9f1aebde26a5814e7a409e81ed679e49f3e83d8ac1d516f9c2dee08f1765d4913b70653f3b01d129c87aefeec5cb669d64163cc3cd343a73784` |
| stream | 2 | `45f40a0d5016b74fa35db2575477ebe3e16e12b4899b3a2136df413ed7337bbf5f8e7e6332796badf8292f04048e8c0a5e1e4bca5a0948df60e3e7e130ec9c2d` |
| stream | 3 | `532736745eea455279931ad2873d9517182e4b9dfbc9c64858128b58ac55b56e2b61616ce14a8edd2121226172501b0473578dc76e319ddb5b01b4496661caff` |
| stream | beacon | `eda470639452c1483fdbaeb62f82488c8015d74c81395b1275b372ac3ef0f73c99804c551bf14acc0af7dcc61e892f7997182bf53f9cbd1babc134aaa4a6bb70` |

## Verify it yourself

You need the final zkeys (shipped with the app as `/circuits/<name>.zkey`, or from the release) and the
public ptau.

```sh
# 1. the public ptau; compare with the blake2b above
curl -LO https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau
b2sum powersOfTau28_hez_final_17.ptau

# 2. the circuits, from this commit; compare with the r1cs table
npm ci && npm run circuits:build
sha256sum build/circuits/*/*.r1cs

# 3. each final key: snarkjs re-derives the initial key from r1cs + ptau and checks every contribution
#    and the beacon. Expect "ZKey Ok!" and the contribution hashes above.
for c in transact grant spend disclose delegate stream; do
  npx snarkjs zkey verify build/circuits/$c/$c.r1cs powersOfTau28_hez_final_17.ptau ${c}_final.zkey
done

# 4. the beacon: the block hash of slot 463490557, base58-decoded, is the beacon value above
curl -s https://api.mainnet-beta.solana.com -H 'content-type: application/json' -d \
  '{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[463490557,{"transactionDetails":"none","rewards":false,"maxSupportedTransactionVersion":0}]}'

# 5. the verifying keys, and the program's embedded copy of them
npx snarkjs zkey export verificationkey ${c}_final.zkey $c.vkey.json   # sha256 as in the table
# put the six vkeys in build/circuits/<name>/<name>.vkey.json, then:
npm run solana:vk -- --check                                            # vk.rs matches
```

The transcript chain can also be checked with the repository tool, given the ceremony directory:
`node scripts/ceremony.mjs verify --dir <dir> --ptau <ptau>` (needs the intermediate keys, which were not
kept; step 3 does not need them, as every contribution proof is inside the final key).

To run the same steps on new keys: `node scripts/ceremony.mjs init --dir D --ptau P --ptau-blake2b HASH
--circuits NAME`, then `contribute --dir D --name N` (repeat), `beacon --dir D --beacon HEX --source TEXT`,
`verify --dir D --ptau P`, `export --dir D`. See the header of `scripts/ceremony.mjs`.

## Later public round

Anyone can extend these keys with `snarkjs zkey contribute` on each final zkey, followed by a new public
beacon; that keeps this round's security and adds theirs. The resulting verifying keys would then replace
`vk.rs` through a program upgrade, and the app's proving keys would be replaced with the new final zkeys.

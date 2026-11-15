import type { PackManifest } from "../voice/packs";

// Ready-made 3D avatars from the Open Source Avatars "100Avatars" collection (github.com/ToxSam/open-source-avatars),
// released under CC0 (public domain, no credit needed). Each file is downloaded on demand from the Arweave network
// and accepted only if it matches the SHA-256 recorded here.
export interface CatalogAvatar {
  id: string;
  name: string;
  pack: PackManifest;
}

function avatar(id: string, name: string, tx: string, sha256: string, size: number): CatalogAvatar {
  return {
    id,
    name,
    pack: {
      id: `avatar-${id}`,
      version: "1",
      lang: "none",
      license: "CC0-1.0",
      credit: `${name}, 100Avatars (Open Source Avatars), CC0`,
      files: [{ name: "model.vrm", url: `https://arweave.net/${tx}`, sha256, size }],
    },
  };
}

export const AVATARS: CatalogAvatar[] = [
  avatar("rose", "Rose", "Ea1KXujzJatQgCFSMzGOzp_UtHqB1pyia--U3AtkMAY", "8e44e5638ffdf935e5d6fa990aa6cba428269f342f2db024c2961ee286a41e5f", 2400964),
  avatar("robert", "Robert", "gwG7w4bY-A5c3R6A6GOz3xBCgbPvkFQmqPIDtvnNsYI", "5e3edaf330577ee4c3f6440b8989af3722e7c800bb90eb037f1c05cdfe61fd7c", 1656464),
  avatar("mikel", "Mikel", "-eJyDjujQRvakRImdvulg-1dKQkPwMeQv-55IbKqLh4", "d53177897756be00446e5bcd0a5ab605b2d29e614f7c491a2d9a7c67dde0be0e", 2026832),
  avatar("polydancer", "Polydancer", "jPOg-G0MPH55ZQmamFhT9f8cHn-hjeAQ0mRO5gWeKMQ", "9bc28f2f2ab9d20aaa0da6c7b272a3f2363058414362bbfc176713c4585e4244", 1242088),
  avatar("rabbit", "Rabbit", "RymRtrmhHx_f9ZDvtvIQb1noTHvILdjoTg5G7L2DR-8", "ea5453d2d74a9bd23a1fb27159e40e8a0d402f3d42a538b28118c1639bc9eae9", 2633752),
  avatar("devil", "Devil", "gfVzs1oH_aPaHVxpQK86HT_rqzyrFPOUKUrDJ30yprs", "2e428dd1846504a77f3936259f489a899cc92aa6179b769a1aee230f875a9b4d", 1393048),
];

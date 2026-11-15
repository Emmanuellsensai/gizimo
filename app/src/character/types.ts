export const ROLES = ["mentor", "friend", "pr", "companion", "accountability"] as const;
export type Role = (typeof ROLES)[number];

export const LANGS = [
  { id: "en", label: "English" },
  { id: "pcm", label: "Pidgin" },
  { id: "yo", label: "Yoruba" },
  { id: "ig", label: "Igbo" },
  { id: "ha", label: "Hausa" },
] as const;
export type Lang = (typeof LANGS)[number]["id"];

export interface CheckIn {
  time: string;
  prompt: string;
}

export interface Character {
  schemaVersion: 1;
  id: string;
  name: string;
  roles: Role[];
  personality: { summary: string; speechStyle: string; boundaries?: string[] };
  languages: Lang[];
  voice: { pack: string; gender?: "female" | "male"; speed?: number; premium?: boolean };
  avatar?: {
    image?: string;
    consentConfirmed?: boolean;
    style?: "photo-warp" | "stylized" | "cartoon" | "vrm";
    model?: string;
    cartoon?: string;
    mouth?: { x: number; y: number; w: number };
    eyes?: { x: number; y: number; w: number }[];
  };
  proactive?: { checkIns?: CheckIn[]; quietHours?: { from?: string; to?: string } };
  skills?: {
    maxTier?: 0 | 1 | 2 | 3;
    allowApps?: string[];
    allowFolders?: string[];
    allowUrlHosts?: string[];
  };
  memory?: { enabled?: boolean; maxItems?: number };
}

export function blankCharacter(): Character {
  return {
    schemaVersion: 1,
    id: "new-character",
    name: "New character",
    roles: ["friend"],
    personality: { summary: "", speechStyle: "", boundaries: [] },
    languages: ["en"],
    voice: { pack: "os", speed: 1, premium: false },
    avatar: { style: "photo-warp", consentConfirmed: false },
    proactive: { checkIns: [] },
    skills: { maxTier: 1, allowApps: [], allowFolders: [], allowUrlHosts: [] },
    memory: { enabled: true, maxItems: 500 },
  };
}

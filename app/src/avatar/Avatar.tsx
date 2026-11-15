import { useEffect, useState } from "preact/hooks";
import type { Character } from "../character/types";
import AvatarCanvas from "./AvatarCanvas";
import Avatar3D from "./Avatar3D";

interface Props {
  character: Character;
  /** How open the mouth should be right now, 0 to 1. */
  getLevel: () => number;
  /** Width of the avatar in pixels. */
  width?: number;
  /** Height in pixels. A 3D character in "full" mode wants a tall box, about 1.6 times the width. */
  height?: number;
  /** "full": the whole body standing. "bust": head and shoulders, for small icons. */
  mode?: "full" | "bust";
  dragRegion?: boolean;
  /** Shows it bigger or smaller on screen (1 is normal). */
  scale?: number;
  /** Change this to make the avatar reload its model (after a new one is saved). */
  version?: number;
}

/** Shows a character as a 3D model when it has one, otherwise as the built-in cartoon face. */
export default function Avatar({ character, getLevel, width = 240, height, mode = "bust", dragRegion = false, scale = 1, version = 0 }: Props) {
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => setFailed(null), [character.id, character.avatar?.model, version]);

  const h = height ?? width;
  if (character.avatar?.style === "vrm" && character.avatar?.model && !failed) {
    return <Avatar3D id={character.id} getLevel={getLevel} width={width} height={h} mode={mode} dragRegion={dragRegion} scale={scale} version={version} onFail={setFailed} />;
  }
  return <AvatarCanvas character={character} getLevel={getLevel} size={Math.min(width, h)} dragRegion={dragRegion} scale={scale} />;
}

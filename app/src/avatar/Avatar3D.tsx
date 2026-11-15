import { useEffect, useRef } from "preact/hooks";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { readAvatarModel } from "./avatarFiles";
import { follow, makeBlinker } from "./level";

interface Props {
  id: string;
  /** How open the mouth should be right now, 0 to 1. Called every frame. */
  getLevel: () => number;
  width?: number;
  height?: number;
  /** "full" shows the whole body standing; "bust" shows head and shoulders (for small icons). */
  mode?: "full" | "bust";
  dragRegion?: boolean;
  /** Only changes how big it is shown on screen (cheap), not how it is drawn. */
  scale?: number;
  version?: number;
  /** Called once if the 3D character cannot be shown, so the caller can fall back to the built-in face. */
  onFail: (message: string) => void;
}

// The five vowel shapes every VRM character has. Cycling through them while the voice is loud reads as talking.
const VOWELS = ["aa", "ih", "ou", "ee", "oh"] as const;
const FOV = 26;

/** Shows a VRM 3D character standing: blinking, breathing, and with a mouth that follows the voice. */
export default function Avatar3D({ id, getLevel, width = 240, height = 240, mode = "bust", dragRegion = false, scale = 1, version = 0, onFail }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ getLevel, onFail });
  live.current = { getLevel, onFail };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    } catch (e) {
      live.current.onFail(`3D graphics are not available here (${String(e)})`);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0); // see-through, so the floating window shows only the character

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 40);
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1, 1.5, 2);
    scene.add(key);

    let disposed = false;
    let vrm: VRM | null = null;
    let raf = 0;

    void (async () => {
      try {
        const bytes = await readAvatarModel(id);
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        const gltf = await loader.parseAsync(bytes, "");
        const loaded = gltf.userData.vrm as VRM | undefined;
        if (!loaded) throw new Error("This file is a 3D model but not a VRM character.");
        if (disposed) return;
        VRMUtils.rotateVRM0(loaded); // old VRM 0.x files face the other way
        scene.add(loaded.scene);

        // Models arrive in a stiff T-pose: let the arms hang down naturally.
        const arm = (name: "leftUpperArm" | "rightUpperArm", angle: number) => {
          const bone = loaded.humanoid?.getNormalizedBoneNode(name);
          if (bone) bone.rotation.z = angle;
        };
        // Older VRM 0.x files turn the other way round, so the same rotation lifts the arms instead of lowering them.
        const flip = (loaded.meta as { metaVersion?: string }).metaVersion === "0" ? -1 : 1;
        arm("leftUpperArm", -1.15 * flip);
        arm("rightUpperArm", 1.15 * flip);
        loaded.scene.updateMatrixWorld(true);

        if (mode === "full") {
          // Stand the whole body in view: fit its height and keep it centred.
          const box = new THREE.Box3().setFromObject(loaded.scene);
          const bodyHeight = Math.max(0.3, box.max.y - box.min.y);
          const middleY = (box.max.y + box.min.y) / 2;
          const distance = (bodyHeight * 0.56) / Math.tan((FOV / 2) * (Math.PI / 180));
          camera.position.set((box.max.x + box.min.x) / 2, middleY + bodyHeight * 0.02, distance);
          camera.lookAt((box.max.x + box.min.x) / 2, middleY, 0);
        } else {
          // Head and shoulders, close enough that the face is easy to read.
          const head = loaded.humanoid?.getNormalizedBoneNode("head");
          const p = new THREE.Vector3(0, 1.4, 0);
          head?.getWorldPosition(p);
          camera.position.set(p.x, p.y + 0.03, p.z + 1.1);
          camera.lookAt(p.x, p.y - 0.1, p.z);
        }
        if (loaded.lookAt) loaded.lookAt.target = camera; // the character looks at you
        vrm = loaded;
      } catch (e) {
        if (!disposed) live.current.onFail(String(e instanceof Error ? e.message : e));
      }
    })();

    const blinker = makeBlinker();
    const clock = new THREE.Clock();
    let level = 0;
    let vowel = 0;
    let vowelUntil = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, clock.getDelta());
      const now = performance.now();
      level = follow(level, Math.min(1, Math.max(0, live.current.getLevel())), dt * 1000);
      if (vrm) {
        const em = vrm.expressionManager;
        if (em) {
          if (now > vowelUntil) {
            vowel = Math.floor(Math.random() * VOWELS.length);
            vowelUntil = now + 90 + Math.random() * 110;
          }
          VOWELS.forEach((v, i) => em.setValue(v, i === vowel ? Math.min(1, level * 1.15) : 0));
          em.setValue("blink", blinker(now));
        }
        const head = vrm.humanoid?.getNormalizedBoneNode("head");
        if (head) {
          head.rotation.y = Math.sin(now / 2300) * 0.06;
          head.rotation.x = Math.sin(now / 1900) * 0.02 + level * 0.03;
        }
        const chest = vrm.humanoid?.getNormalizedBoneNode("chest") ?? vrm.humanoid?.getNormalizedBoneNode("spine");
        if (chest) chest.rotation.x = Math.sin(now / 1400) * 0.012; // breathing
        vrm.update(dt);
      }
      renderer.render(scene, camera);
    };
    frame();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (vrm) {
        scene.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
      }
      renderer.dispose();
    };
  }, [id, width, height, mode, version]);

  return (
    <canvas
      ref={ref}
      class="avatar-canvas"
      style={{ width: `${width * scale}px`, height: `${height * scale}px` }}
      {...(dragRegion ? { "data-tauri-drag-region": true } : {})}
    />
  );
}

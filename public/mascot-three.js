// Three.js is vendored and pinned; no CDN, API key or external requests at runtime.
export async function createThreeHydra() {
  const THREE = await import('./vendor/three.module.min.js');
  const { GLTFLoader } = await import('./vendor/GLTFLoader.js');
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power', preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.className = 'mascot-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const scene = new THREE.Scene();
  const hemisphere = new THREE.HemisphereLight(0xe9fff6, 0x395e78, 2.0); scene.add(hemisphere);
  const key = new THREE.DirectionalLight(0xffefd9, 3.0); key.position.set(-3, 6, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0x97ebff, 1.6); fill.position.set(4, 3, -3); scene.add(fill);
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 50);
  camera.position.set(2.3, 2.6, 9); camera.lookAt(0, 1.5, 0);
  let gltf;
  try { gltf = await new GLTFLoader().loadAsync('/mascot-hydra.glb'); }
  catch (error) { renderer.dispose(); throw error; }
  const model = gltf.scene;
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = 3.1 / Math.max(size.y, 0.001);
  const normalized = new THREE.Group();
  model.scale.multiplyScalar(scale);
  model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  normalized.add(model); scene.add(normalized);
  const mixer = new THREE.AnimationMixer(model);
  const clips = new Map(gltf.animations.map(clip => [clip.name.toLowerCase(), clip]));
  const actions = new Map();
  for (const name of ['idle', 'walk', 'listen', 'talk']) {
    const clip = clips.get(name) || [...clips.entries()].find(([key]) => key.includes(name))?.[1];
    if (clip) actions.set(name, mixer.clipAction(clip));
  }
  const eyes = [], irises = new Set();
  model.traverse(object => {
    if (/^EyePivot_/.test(object.name)) eyes.push(object);
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (/iris/i.test(material?.name || '')) irises.add(material);
    }
  });
  let current = null, previousTime = null, disposed = false, width = 0, height = 0;
  let lastColor = '', yaw = 0;
  const rotation = new THREE.Quaternion();
  function resize(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (w === width && h === height) return;
    width = w; height = h;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    const frame = Math.max(3.75, size.x * scale / aspect + .6);
    camera.left = -frame * aspect / 2; camera.right = frame * aspect / 2;
    camera.top = frame / 2; camera.bottom = -frame / 2;
    camera.updateProjectionMatrix();
  }
  function update(time, context) {
    if (disposed) return;
    const dt = previousTime === null ? 0 : Math.min(.05, Math.max(0, time - previousTime)); previousTime = time;
    const name = context.status === 'responding' ? 'talk' : context.status === 'listening' ? 'listen' : context.walking ? 'walk' : 'idle';
    const next = actions.get(name) || actions.get('idle');
    if (next && next !== current) {
      current?.fadeOut(.3);
      next.reset().setEffectiveTimeScale(name === 'walk' ? (.98 / 3) / (.443 * scale) : 1).setEffectiveWeight(1).fadeIn(.3).play(); current = next;
    }
    if (context.reducedMotion) { mixer.setTime(0); }
    else mixer.update(dt);
    // Every clip keys these pivots. Add gaze to the current animated pose so
    // small eye movements survive, while parent eyelid bones keep blinking.
    for (const object of eyes) {
      if (!context.reducedMotion) {
        rotation.setFromEuler(new THREE.Euler(-context.lookY * .17, 0, -context.lookX * .23));
        object.quaternion.multiply(rotation);
      }
    }
    normalized.position.x = context.reducedMotion ? 0 : context.travel * .07;
    const targetYaw = context.walking ? context.direction * 1.2 : context.lookX * .045;
    yaw += (targetYaw - yaw) * (1 - Math.exp(-dt * 5));
    normalized.rotation.y = context.reducedMotion ? 0 : yaw;
    if (context.color && context.color !== lastColor) {
      lastColor = context.color;
      for (const material of irises) {
        material.color.setStyle(context.color);
        if (material.emissive) { material.emissive.setStyle(context.color); material.emissiveIntensity = .18; }
      }
    }
    renderer.render(scene, camera);
  }
  function destroy() {
    disposed = true; mixer.stopAllAction(); mixer.uncacheRoot(model);
    model.traverse(object => {
      object.geometry?.dispose();
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (!material) continue;
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
    renderer.dispose(); canvas.remove();
  }
  return { element: canvas, update, resize, destroy, clips: [...actions.keys()] };
}

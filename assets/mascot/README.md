# Hydra articulada

A fonte editável é `hydra.blend`, criada por `create_hydra.py` numa cena isolada. O script recria o modelo, os materiais e o esqueleto, exporta `public/mascot-hydra.glb` e renderiza `output/hydra-model-preview.png`.

```bash
blender --background --factory-startup --python assets/mascot/create_hydra.py
```

Modelo final: 45 ossos, 1 skin, cerca de 74 mil triângulos, quatro animações (`Idle`, `Walk`, `Listen`, `Talk`). Os pescoços têm três segmentos deformáveis por cabeça; as quatro patas usam cinemática inversa na fase de apoio. Não há translação da raiz nos clips. O runtime coordena o avanço com a marcha. `Iris` é o material usado para a cor do cliente. Os ossos `EyePivot_0_L/R` até `EyePivot_2_L/R` permitem acrescentar o olhar do ponteiro às animações.

Three.js 0.180.0 é servido localmente em `public/vendor`; a licença MIT upstream está em `three.LICENSE.txt`. Os imports locais de GLTFLoader/BufferGeometryUtils foram ajustados para essa cópia. Não são usadas CDN, bibliotecas externas em tempo de execução nem serviços de geração.

`public/mascot-art.js` e `public/mascot-vector.js` fornecem a alternativa SVG articulada para dispositivos sem WebGL2. A imagem original `public/mascot-hydra.png` fica preservada como referência; já não é o desenho que se move na interface.

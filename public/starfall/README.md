# Starfall

Jogo espacial 2D no browser, sem dependências. A nave dispara sozinha, destrói inimigos, recolhe experiência e escolhe melhorias entre ondas cada vez mais difíceis.

## Abrir

Abre `index.html` diretamente (`file://`). O servidor do HYDRAQ só entrega uma lista fixa de ficheiros em `lib/http.mjs` e não inclui `starfall/`, por isso `/starfall/index.html` responde 404 enquanto essa lista não for alterada. Este jogo não muda o servidor.

## Jogar

- WASD ou setas. No telemóvel, o comando redondo à esquerda.
- O disparo é automático e não há som.
- Núcleos amarelos dão XP. Em cada nível escolhes uma de três melhorias: laser, rajada, mísseis, drones, dano, cadência, escudo, vida ou velocidade.
- P ou Escape pausa. Perder o foco da janela também suspende.
- São 6 ondas. Há chefes na 3.ª e na 6.ª. A vitória é destruir o Núcleo Estelar no fim da 6.ª. Reiniciar limpa a partida.

## Testes

```bash
node --test public/starfall/logic.test.mjs
```

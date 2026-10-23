# Validação Starfall

Abrir: `file:///home/sauron/Documentos/ChatGPT/HYDRAQ/public/starfall/index.html`

O servidor em `lib/http.mjs` só entrega uma lista fixa e não inclui `starfall/`. Este trabalho não alterou esse ficheiro. `/starfall/index.html` continua indisponível até essa lista mudar.

## Testes Node

Comando exacto: `node --test public/starfall/logic.test.mjs`

Resultado observado: 10 testes, 10 aprovados, 0 falhados, exit 0.

Cobrem XP e escolhas acumuladas, armas, colisões, ondas/vitória por estado de teste, limite de `dt`, reinício, contacto durante invulnerabilidade, catálogo esgotado e fallback, limpeza do input de foco, e HUD com quatro armas de nível 3 em 320, 390, 760, 800, 960, 1100 e 1280. A suite do HYDRAQ não foi executada.

A vitória deste ficheiro de teste esvazia a fila e os inimigos da onda 6. Não é uma partida jogada.

## Browser

Chrome `/usr/bin/google-chrome` em headless, depuração local, `file://` acima. Sem `--disable-web-security` nem equivalente.

Acções na página:

- Menu visível com «Iniciar». Clique real. Modo `playing`.
- Tecla W cerca de 280 ms: a nave subiu de y 556 para y 477. Havia 3 disparos do jogador.
- Blur com W ainda premida: pausa por foco e texto «A janela perdeu o foco». Continuar: y manteve-se 477 nos 180 ms seguintes.
- P: modo `paused`.
- Derrota: um disparo inimigo foi colocado no estado em cima da nave. O painel «Nave destruída» apareceu, vida 0. O botão Reiniciar voltou a `playing`, nível 1, vida 100, onda 1, pontuação 0, zero melhorias.

Injecção de estado, não jogada até ao fim:

- Um núcleo de XP foi inserido. Abriu escolha com 3 botões e 2 níveis pendentes. Cliques reais escolheram dano e depois cadência; os dois ficaram em `taken` e o dano manteve 1.25.
- Laser, rajada, mísseis e drones foram postos no nível 3 só para o HUD.

Layout medido: `scrollWidth` igual a `innerWidth` em 320, 390 e 1280. Sem overflow horizontal. Capturas: `proof-menu-desktop.png`, `proof-defeat-desktop.png`, `proof-hud-320.png`, `proof-hud-390.png`, `proof-hud-desktop.png`. A 320 px lê-se `Canhão · Las 3 · Raj 3 · Mís 3 · Dro 3`. No desktop lê-se a linha completa das quatro armas.

Não observado no browser: chegar ao chefe ou à vitória a jogar as 6 ondas, nem um toque físico no comando. O comando vê-se nas capturas estreitas.

Consola do Chrome durante este percurso: sem erros registados.

## HUD em larguras intermédias

Correcção posterior: o texto e as barras ficam em faixas separadas em qualquer largura. O desenho mede cada linha com `canvas.measureText`.

Novo teste Node, no mesmo comando: 10 testes, 10 aprovados, 0 falhados, exit 0. O caso do HUD percorre 320, 390, 760, 800, 960, 1100 e 1280 com a estimativa de largura do teste, não com o canvas.

Browser, mesma página `file://`, Chrome headless sem desligar a segurança de origem. Depois de Iniciar, as quatro armas foram injectadas no nível 3. `hudLayout` usou o `measureText` do canvas da página:

- 760: linha `Canhão · Laser 3 · Rajada 3 · Mísseis 3 · Drones 3`, folga 8 px, `fits` verdadeiro, 0 cruzamentos, scroll 760.
- 960: a mesma linha, folga 8 px, 0 cruzamentos, scroll 960.
- 1100: a mesma linha, folga 8 px, 0 cruzamentos, scroll 1100.

Capturas: `proof-hud-760.png`, `proof-hud-960.png`, `proof-hud-1100.png`. Não foi repetido o ciclo de jogo.

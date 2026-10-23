# Claude original: terminal, app e HYDRAQ

A HYDRAQ continua a executar o Claude Code por `claude -p` com `stream-json`. O terminal original é um processo à parte: não passa pela HYDRAQ, por isso a passagem é uma troca de controlo e não um espelho em direto.

## Continuar no terminal

Em **Configurações e detalhes → Claude original**, **Abrir no terminal** fica disponível depois do primeiro pedido concluído (o Claude Code tem de ter guardado a sessão). A HYDRAQ:

1. confirma que a conversa não tem tarefa, autorização ou reserva ativa;
2. termina o seu processo dessa sessão;
3. guarda o ponto de partida (o último registo da transcrição nativa) na conversa, no disco;
4. abre `x-terminal-emulator` ou mostra o comando: `cd <pasta> && claude --resume <ID> --model … --effort … --permission-mode …` (e a indicação para ler `AGENTS.md`, como nos pedidos da HYDRAQ).

Enquanto a conversa está no terminal, a HYDRAQ não envia pedidos, orientações, pareceres nem passagens desse grupo e reserva a pasta/projeto para outro trabalho. O Claude da HYDRAQ continua disponível noutras pastas. A reserva sobrevive a um reinício da HYDRAQ.

**Continuar na HYDRAQ** só é aceite quando nenhum Claude tem a sessão aberta: a HYDRAQ consulta `claude agents --json` e, em Linux, procura também processos iniciados com esse ID. Se a listagem do CLI falhar, a HYDRAQ não presume que a sessão está fechada (uma sessão escolhida dentro do Claude não tem o ID nos argumentos): a conversa fica no terminal até confirmares explicitamente que fechaste o Claude. O mesmo acontece se a transcrição faltar ou tiver linhas ilegíveis: só continua com a tua decisão, que fica registada na conversa. Depois lê a transcrição nativa (`~/.claude/projects/<pasta>/<ID>.jsonl`, ou `CLAUDE_CONFIG_DIR`) e acrescenta só o que veio depois do ponto de partida:

- pedidos escritos no terminal, respostas visíveis e ferramentas (comandos, ficheiros, pesquisas, subagentes), com estado concluído, falhado, recusado ou interrompido;
- um pedido só fica concluído com a marca de fim do próprio Claude (`stop_reason: end_turn`) e todas as ferramentas com resultado. Um pedido sem resposta, com texto parcial ou com ferramenta por terminar fica interrompido, com aviso, e o texto não é apresentado como resposta final nem passado a outro cliente como conclusão. Os resultados de ferramentas chamadas em paralelo são associados pelo ID, porque ficam em ramos laterais da transcrição;
- os ficheiros alterados entram nos factos da conversa e na passagem para outros clientes;
- compactações aumentam a época de contexto; comandos locais (`/model`, `/login`…), avisos e subagentes internos não são importados.

O pedido seguinte na HYDRAQ retoma a mesma sessão (`--resume`), por isso o Claude lembra-se do que foi feito no terminal.

## Associar uma sessão existente

**Associar sessão Claude existente** lista as sessões do Claude Code guardadas na pasta indicada pelo terminal (`cli`) ou pela app Claude (`claude-desktop`), com o título do próprio Claude quando existe. Sessões criadas por programas (`sdk-*`), incluindo as da HYDRAQ, ficam de fora. A associação recusa sessões abertas noutro Claude ou de outra pasta, mantém o ID nativo e importa o histórico; sem confirmação do CLI ou com linhas ilegíveis, pede a mesma decisão explícita. As conversas normais de claude.ai (chat no browser, app ou telemóvel) ficam nos servidores da Anthropic e não aparecem; sessões do Claude Code na web exigem `claude --teleport`.

## Perguntas do Claude

O cliente principal aceita `AskUserQuestion`. As perguntas aparecem na conversa com as opções do Claude, escolha múltipla quando pedida e um campo para resposta própria. **Responder** envia `answers` (pergunta → rótulo, vários rótulos separados por vírgulas ou o texto escrito); **Não responder** recusa a ferramenta; **Parar tarefa** interrompe. Uma resposta incompleta é recusada sem resolver o pedido. Revisores, pareceres e o revisor da colaboração continuam sem esta ferramenta.

## Isolamento

Cada processo Claude da HYDRAQ recebe `--settings {"crossSessionInbound":"refuse"}`. Sem isto, outra sessão Claude do computador podia enviar uma mensagem a um processo parado da HYDRAQ e iniciar um turno que a HYDRAQ não pediu (com consumo de quota e contexto invisível na conversa). O ambiente dos processos perde também a identidade de uma sessão Claude que tenha iniciado a HYDRAQ (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, socket e token de mensagens): com elas, o terminal original não grava os seus turnos.

## Limites

- Durante o terminal não há acompanhamento em direto na HYDRAQ; o consumo desses pedidos fica registado na sessão nativa.
- `/clear` no terminal começa outra sessão, que não volta automaticamente; podes associá-la depois.
- Se a conversa for rebobinada para antes do ponto de partida, a HYDRAQ importa o ramo novo e avisa; o histórico anterior continua visível, mas o Claude segue a partir desse ponto.
- O trabalho dos membros de uma equipa de agentes fica nas suas transcrições; a HYDRAQ importa o que o Claude principal mostra.
- O servidor MCP de memória do projeto não é passado ao terminal.
- Windows ainda não é suportado.

Validação: `.hydraq/claude-original-2026-10-23/VALIDACAO.md`.

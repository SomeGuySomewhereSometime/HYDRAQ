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

## Memória do projeto no terminal

Ao abrir no terminal uma conversa associada a um projeto, a HYDRAQ acrescenta as quatro ferramentas MCP de consulta através de um ficheiro privado `--mcp-config` e pré-autoriza apenas essas quatro com `--allowedTools`, como nos seus próprios processos. O botão e o comando manual usam a mesma configuração; os MCP pessoais continuam disponíveis e as restantes ferramentas seguem as autorizações habituais. A credencial não aparece no comando nem no ficheiro de configuração: o helper lê-a de um ficheiro privado separado em cada consulta.

O servidor HYDRAQ tem de estar disponível. Durante uma paragem, as consultas indicam que a memória está indisponível e que se deve aguardar. No arranque, a HYDRAQ reemite a credencial das conversas que continuam no terminal, no mesmo caminho: um helper já aberto recupera na consulta seguinte. A autorização não expira enquanto a conversa estiver no terminal e continuar no projeto autorizado. Ao regressar, volta o prazo normal de uma hora.

Arquivar a conversa ou o projeto, ou mudar a conversa de projeto, revoga o acesso: o token é substituído no mesmo ficheiro pelo motivo, e o terminal passa a responder que a conversa já não tem acesso à memória daquele projeto, em vez de pedir para aguardar. Se a mudança acontecer com a HYDRAQ desligada, o arranque volta a deixar o motivo. Desarquivar ou voltar ao projeto autorizado devolve o acesso ao terminal aberto. Guardar a organização sem mudar o projeto não revoga.

As consultas bem-sucedidas ficam guardadas enquanto o terminal está aberto. No regresso, são comparadas com as chamadas MCP nativas da transcrição (mesmo servidor, ferramenta e argumentos):

- uma consulta e uma chamada no mesmo pedido: associação à chamada (`tool-and-arguments`, com o ID nativo);
- várias consultas ou chamadas iguais, todas no mesmo pedido: associação a esse pedido (`request`), sem escolher uma chamada concreta. Uma consulta de um subagente durante o pedido fica no mesmo pedido;
- cada consulta tem de estar entre a primeira chamada correspondente e o fim do pedido;
- chamadas iguais em pedidos diferentes, ramos não importados e consultas fora do intervalo ficam como `unidentified-request` em `unattributedContextReads`. A hora, sozinha, nunca decide.

Até 1000 consultas pendentes/sem pedido são conservadas por conversa; excedentes têm contador explícito. O regresso aguarda consultas já admitidas antes de importar o histórico.

Validado com o Claude Code interativo (2.1.309 e 2.1.310), aberto com o comando gerado, em perfil e HYDRAQ isolados: consultas sem pedido de autorização em modo normal e em Planear, mensagem de indisponibilidade com a HYDRAQ parada, recuperação do mesmo terminal depois de reiniciar a HYDRAQ (marcador de memória novo) e regresso com os pedidos e as consultas associados. Scripts em `validation/claude-terminal-interactive.py`.

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
- O MCP acrescentado exige uma conversa associada a um projeto e o servidor disponível; sessões abertas antes desta integração precisam de ser abertas novamente com o novo comando para receberem a configuração.
- Windows ainda não é suportado.

Validação: `.hydraq/claude-original-2026-10-23/VALIDACAO.md`; memória no terminal em `.hydraq/terminal-memory-2026-10-24/VALIDACAO.md` e `.hydraq/terminal-memory-review-2026-10-24/VALIDACAO.md`.

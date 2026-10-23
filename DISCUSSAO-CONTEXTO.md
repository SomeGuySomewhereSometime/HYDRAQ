# HYDRAQ — Discussão sobre continuidade de contexto e memória incremental

**Data:** 21 de outubro de 2026  
**Origem:** conversa do utilizador com o ChatGPT  
**Estado:** documento de discussão e proposta; **não é uma ordem para implementar**.  
**Âmbito:** comunicação entre clientes/modelos, passagem de contexto, memória automática por projeto e aproveitamento das funcionalidades existentes.

> Este documento regista fielmente as questões, conclusões e recomendações da conversa, mas não é uma transcrição palavra por palavra. O código e o estado do HYDRAQ podem mudar; confirmar sempre antes de implementar.

## 1. Questão central do utilizador

O utilizador quer que o HYDRAQ mantenha, continuamente, um registo do trabalho realizado pelos agentes, para que outro modelo possa continuar sem ter de pedir ao primeiro modelo um resumo adicional sempre que ocorre uma mudança de cliente.

Ideia expressa na conversa, em paráfrase:

- Sempre que um agente modifica ficheiros, executa testes, resolve um problema ou toma uma decisão, o HYDRAQ anota as novidades num registo incremental.
- Quando se muda, por exemplo, de Codex para Claude ou Grok, o destinatário recebe ou consulta esse registo, acrescido apenas do que ainda não recebeu.
- O objetivo é preservar continuidade, reduzir latência e evitar consumir quota numa chamada extra exclusivamente para resumir.
- O utilizador também perguntou se já existia memória partilhada por projeto nas várias conversas do HYDRAQ, independentemente do `AGENTS.md` do projeto.

Não foi pedida implementação nesta fase: primeiro foi solicitada análise e depois a criação deste ficheiro para disponibilizar a discussão aos agentes locais.

## 2. O que já existe no HYDRAQ (confirmado na revisão do código em 21/10/2026)

### Passagem entre clientes

Em `lib/providers.mjs` e `lib/handoff.mjs`:

- **Passagem completa (predefinida na interface):** quando há turnos da origem ainda não cobertos, o cliente de origem recebe um **pedido interno adicional** para produzir um resumo, em português, até cerca de 400 palavras, com objetivo/restrições, decisões, trabalho realizado, pendentes e riscos. Esse pedido usa o modelo e a quota da origem.
- **Passagem rápida:** não faz a chamada adicional. O HYDRAQ compõe o contexto a partir dos dados e eventos já guardados.
- **Ambas** transferem, segundo a cobertura disponível: pedidos anteriores, orientações do utilizador, respostas finais ou parciais, ficheiros alterados/observados, comandos e códigos de saída, erros, recusas, avisos de incerteza, resumos já existentes e `git status`.
- O destino conserva a sua sessão nativa, se já existir. Os turnos ainda não recebidos são identificados; a passagem só conta como recebida após a confirmação de conclusão do turno no destino. Não se reenviam automaticamente pedidos incertos.
- O contexto de passagem tem um orçamento de tamanho. Material opcional pode ser encurtado; conteúdo considerado essencial acima do limite bloqueia o envio, em vez de ser silenciosamente eliminado.

### Recolha automática de factos

Em `lib/turn-facts.mjs`, o HYDRAQ já observa e guarda factos estruturados das ações: edições concluídas comunicadas pelo cliente, comandos e estados/códigos de saída, ações recusadas e erros. A recolha não necessita de outra inferência do modelo.

**Diferença importante:** isto **não constitui ainda um resumo narrativo incremental** dos objetivos, decisões e pendentes, atualizado automaticamente a cada tarefa. O sistema sabe vários factos operacionais; não conhece necessariamente o raciocínio prático de cada decisão.

### Memória por projeto (já existe)

Em `lib/project-context.mjs` e `.hydraq/project-memory/<projectId>.json`:

- Há **memória curada partilhada por projeto**, separada das conversas individuais e do `AGENTS.md`, com versões, controlo de revisão e limite atual de 2500 caracteres.
- Esta memória é **guardada explicitamente após revisão**. O HYDRAQ pode pedir uma proposta a um modelo, mas é inferência adicional e não é aplicada automaticamente.
- Existe **atividade recente automática**, derivada dos históricos, de até cinco outras conversas e com orçamento de cerca de 2000 caracteres. Não representa transcrição integral.
- Codex, Claude e Cursor podem usar ferramentas MCP de leitura para consultar memória e excertos de outras conversas do projeto. A integração MCP equivalente no Antigravity encontrava-se desativada na revisão, por exigir configuração global; a importação explícita e o contexto enviado normalmente continuam possíveis.
- A memória e as novidades são enviadas quando necessário; não se repetem indiscriminadamente a cada pedido já confirmado.

### `AGENTS.md` e `AI_CHANGES.md` não são esta memória automática

- `AGENTS.md`: instruções aplicáveis aos agentes no projeto.
- `AI_CHANGES.md`: registo e resumo de alterações de desenvolvimento do próprio HYDRAQ, mantido segundo as instruções do projeto.
- Memória por projeto do HYDRAQ: mecanismo privado próprio que permite partilha entre conversas desse projeto.
- **Lacuna identificada:** ainda falta um registo operacional incremental, automático, por projeto, que consolide o progresso de múltiplas conversas sem requerer aprovação de cada anotação factual nem uma inferência separada a cada passagem.

## 3. Proposta debatida — memória operacional incremental

Manter **três camadas distintas**, aproveitando o que já está implementado:

1. **Instruções do projeto** — `AGENTS.md`, políticas, convenções e restrições.
2. **Memória curada** — decisões duradouras, objetivo e restrições, com revisão humana e histórico.
3. **Memória operacional automática** — registo incremental por projeto e por tarefa, baseado em factos observados e, quando disponível, no resumo explícito que o modelo já forneceu no turno normal.

### Modelo sugerido de registo

Cada atualização teria informação como:

- Identificação do projeto, conversa, cliente/modelo, pedido/turno e hora.
- Objetivo e pedido relevante do utilizador.
- Alterações de ficheiros observadas, com indicação clara do nível de confirmação.
- Comandos/testes observados e resultado comunicado.
- Problemas, recusas e resultados incertos.
- Decisões e justificação resumidas **apenas quando explicitamente declaradas**, sem inventar explicações nem tentar recolher raciocínio interno.
- Pendentes e próximo passo, quando declarados.
- Proveniência de cada afirmação: observação do HYDRAQ, declaração do modelo, confirmação por teste ou revisão do utilizador.

### Como seria a passagem

Exemplo ilustrativo:

1. O Codex recebe um pedido e altera `auth.js` e `server.js`; executa 12 testes.
2. O HYDRAQ regista as ações e resultados **durante** o turno ou quando este termina, sem chamada extra.
3. Se a resposta normal do Codex incluir decisões ou próximos passos, o sistema aproveita-os com indicação de proveniência. Opcionalmente, no próprio pedido normal pode solicitar-se uma pequena secção de estado, evitando um novo turno só para resumir.
4. Ao passar para Claude, este recebe **o estado operacional útil e apenas as novidades ainda não recebidas**, além do pedido atual, mantendo as verificações de incerteza e acesso.
5. Se o Claude voltar ao Codex, a sessão nativa do Codex é retomada e só são transmitidos os acontecimentos entretanto ocorridos.

Um ficheiro legível (por exemplo, um Markdown gerado) pode ser uma vista desta memória; o armazenamento interno deve manter identidade, revisões, proveniência, cobertura de entregas e segurança adequadas. **Não depender de um único texto livre como fonte de verdade.**

## 4. Recomendações e limites importantes

- **Preferência discutida:** transformar a passagem incremental, sem inferência extra, no comportamento por defeito; manter a passagem completa, com novo resumo pelo modelo, como opção para casos difíceis.
- Não substituir o histórico completo pelos resumos: preservar origem e permitir abrir os turnos originais.
- Não inferir que um teste passou só porque foi mencionado: distinguir a afirmação do modelo do resultado observado de uma ferramenta.
- Confirmar o estado atual do disco/Git antes de continuar a editar. Resumos podem estar desatualizados e não provam o estado real.
- Evitar duplicações: registar o que foi entregue a cada sessão e enviar só as novidades; não contar entregas de pedidos interrompidos/incertos como confirmadas.
- Não partilhar automaticamente dados entre projetos diferentes. A memória por projeto deve respeitar associações, arquivo, revogação e permissões existentes.
- Não armazenar segredos, tokens nem raciocínio interno dos modelos. Aplicar filtragem e limites de tamanho e preservar as regras de acesso existentes.
- Evitar que um registo demasiado comprido aumente o custo em tokens: manter um estado condensado para leitura normal e um histórico detalhado consultável a pedido.
- O sistema automático deve ser sobretudo **determinístico**. A interpretação de decisões e o resumo semântico podem ser opcionais, aproveitados do turno normal ou solicitados explicitamente.
- Verificar o impacto tanto nas **mudanças de cliente dentro do mesmo grupo de conversa** como no **arranque de outra conversa associada ao mesmo projeto**. São dois casos diferentes.
- Integrar sem quebrar as funcionalidades recentes de colaboração Codex–Grok, gestão de autorizações e processos. A versão 28 de `AI_CHANGES.md` descrevia colaboração sequencial e recuperação de tarefas em 21/10/2026; o working tree tinha desenvolvimento não concluído, que não deve ser sobrescrito.

## 5. Onde investigar caso se decida implementar

- `lib/providers.mjs`: preparação e entrega do contexto, seleção de passagem completa/rápida, controlo da entrega.
- `lib/handoff.mjs`: factos, resumos de origem, turnos não recebidos e construção da passagem.
- `lib/turn-facts.mjs`: recolha de observações automáticas por ação.
- `lib/project-context.mjs`: memória curada, atividade recente, consulta e entrega de contexto por projeto.
- `lib/memory-proposals.mjs`: propostas facultativas com inferência.
- `lib/collaboration.mjs`: fluxo mais recente de trabalho entre principal e executor.
- `README.md`, `AI_CHANGES.md` e testes em `test/`: comportamento declarado, decisões, limitações e regressões.

Antes de mexer: reler o código atual, `AGENTS.md`, `AI_CHANGES.md` e `git status`; preservar edições concorrentes. Este documento **não autoriza automaticamente** alterações de código, execuções de agentes, chamadas de inferência, commits ou modificações às definições de segurança.

## 6. Conclusão da conversa

**Já existe muita da infraestrutura necessária.** A passagem rápida recolhe factos sem chamada adicional e a memória partilhada por projeto já funciona. Falta principalmente uma **visão operacional incremental consolidada**, mantida automaticamente, que faça a ponte entre o progresso das tarefas e o contexto entregue a outros agentes.

A evolução preferida é **reutilizar os mecanismos existentes**, não construir um segundo orquestrador nem substituir os adaptadores nativos. A passagem completa com resumo produzido pelo modelo continua disponível quando acrescentar valor real.

**Estado deste documento:** apenas registo da conversa para consulta por Codex, Claude, Grok, Gemini ou outro agente que tenha acesso à pasta. Nenhuma funcionalidade nova foi implementada por este documento.

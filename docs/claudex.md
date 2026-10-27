# ClaudeX, Geminex e Claudini

Modo de análise, pesquisa e planeamento com dois participantes distintos entre Codex, Claude e Antigravity. A dupla recebe o nome ClaudeX (Codex + Claude), Geminex (Codex + Gemini via Antigravity) ou Claudini (Claude + Gemini via Antigravity). O Dual conserva o seu funcionamento independente.

## Utilização

1. Liga os dois clientes pretendidos nas Conversas e abre a aba **ClaudeX**. Escolhe os participantes A e B; a ordem não determina quem escreve o documento.
2. O par inicial preferido é GPT-6.1 Sol + Claude Opus 5.5, quando disponível no catálogo. Para Antigravity, a preferência é Gemini 4 Argon; os restantes modelos são opcionais. Escolhe o raciocínio, o projeto opcional ou pasta para pesquisa, e o autor que prepara o documento comum.
3. Mantém **Exigir aprovação dos dois** para obter uma única resposta aprovada por ambos. **Síntese do autor** produz um documento sem esse requisito e sem o selo de acordo.
4. Escolhe as proteções: **30 turnos por participante e 60 minutos ativos** por defeito. **0 desativa** a proteção respetiva. São limites de consumo configuráveis que pausam o trabalho e conservam o progresso.
5. Envia o pedido. Podes acompanhar os participantes e abrir o diálogo. Um novo requisito na caixa chega aos dois e invalida aprovações anteriores.
6. **Pausar os dois** interrompe os participantes e conserva a mesma tarefa. O motivo aparece na interface; em pausa, podes editar as proteções e usar **Retomar a mesma tarefa**, com a caixa vazia ou um requisito novo opcional. **Terminar tarefa** liberta as conversas e conserva o progresso; uma retoma posterior só é aceite se as sessões nativas continuarem compatíveis.
7. Quando terminam, o documento fica em destaque; versões anteriores e contribuições continuam consultáveis. **Nova tarefa a partir deste progresso**, disponível nas tarefas terminadas, cria outra tarefa com a origem do contexto identificada: com sessões novas, ou na mesma conversa se a anterior correu numa conversa (ver «Na mesma conversa»).

As duas conversas são normais, do mesmo grupo, com as suas sessões nativas. O coordenador prepara ambos os contextos antes do primeiro envio. As continuações automáticas e a retoma após pausa mantêm o identificador da tarefa, o histórico e as duas conversas nativas. Depois de uma falha ou reinício, a recuperação também exige uma retoma explícita; não existe reenvio automático de pedidos cuja entrega ficou incerta. Se a entrega nativa não puder ser confirmada, a retoma é recusada. **Nova tarefa com este progresso** permite abrir outras sessões com o contexto anterior identificado e conserva a tarefa original.

## Comunicação e acordo

Cada participante regista uma posição independente antes de ler o colega. Depois trabalham sobre o mesmo problema: procuram evidência, confrontam pressupostos e argumentos, respondem às objeções do outro e incorporam correções no documento comum. Uma caixa de mensagens própria da tarefa funciona também sem projeto associado. O envio grava a mensagem e regressa imediatamente; nenhum envio fica bloqueado à espera da resposta do outro.

Codex e Claude podem receber um aviso durante o turno para consultar a caixa. O Antigravity não aceita esse aviso no protocolo atual: as instruções pedem leitura após etapas relevantes de investigação e antes de concluir, sem polling repetitivo. O momento da leitura depende do cliente e dos pontos em que aceita informação: não existe interrupção garantida a meio de cada token. Quando necessário, um participante que terminou recebe uma continuação enquanto o outro ainda trabalha, respeitando as proteções configuradas. As mensagens do colega têm autoria explícita e nunca são apresentadas como ordens do utilizador.

Para concluir, ambos declaram prontidão após lerem as mensagens atuais. O autor propõe uma versão. Cada aprovação fica associada ao identificador e hash do documento, à revisão do pedido e à última mensagem considerada. Toda a nova contribuição com conteúdo invalida as aprovações; não existe uma categoria livre de «nota menor» que permita contornar esta regra. O acordo só é publicado depois de ambos terminarem, sem perguntas pendentes. A resposta publicada fica disponível para passagens de contexto como documento comum ClaudeX.

O resultado distingue os casos seguintes:

- **Resposta comum**: ambos aprovam o documento e as suas conclusões.
- **Acordo sobre as divergências**: ambos aprovam a mesma descrição dos pontos comuns e das diferenças; as posições distintas continuam atribuídas aos participantes escolhidos. Aprovar essa descrição não significa que tenham passado a defender a mesma posição.
- **Sem acordo**: o documento identifica as posições de cada participante e o que ficou por resolver, sem apresentar um consenso inexistente.
- **Síntese do autor**: opção explícita sem aprovação obrigatória dos dois, identificada como tal.

## Proteções e recuperação

O documento final admite até 100 000 caracteres. O transporte das chamadas ClaudeX admite até 640 000 bytes por pedido, incluindo a codificação JSON.

- As proteções por defeito são 30 turnos por participante e 60 minutos de trabalho ativo. O tempo em pausa não conta. Cada retoma abre uma nova contagem com os valores configurados; os turnos totais e o tempo acumulado continuam guardados. Cada valor pode ser alterado antes de iniciar ou durante uma pausa; 0 desativa essa proteção. Cada participante pode gastar a quota da sua subscrição em vários turnos.
- Não há os anteriores limites fixos de contribuições, chamadas de coordenação, versões finais ou revisões do pedido. As proteções configuradas e os limites de armazenamento e de tamanho continuam a aplicar-se.
- Até 100 tarefas e 16 MB no arquivo de coordenação. A continuação transporta até 200 KB de contexto; acima disso é recusada com explicação, preservando o original.
- Sem acordo, falha nativa ou proteção atingida: conserva-se o progresso e a interface não anuncia consenso.
- Pausar revoga primeiro a comunicação e novos despertares, e depois pede a interrupção dos dois clientes. Se um cliente não confirmar a interrupção, a interface mostra o erro, conserva a reserva e permite voltar a tentar parar. Enquanto os envios anteriores terminam, a interface mostra **A pausar os dois** e desativa a retoma. Mensagens antigas não reativam a tarefa. Retomar requer uma ação explícita, conserva as sessões nativas e só é aceite sem trabalho nativo ativo nem entrega incerta.
- Um reinício conserva as tarefas ativas em pausa, com o progresso por confirmar e não repete automaticamente pedidos nativos. A interface permite retomar explicitamente a mesma tarefa depois de confirmar o progresso.
- Enquanto uma tarefa está ativa, os seus clientes, grupo e pasta ficam reservados; a tarefa coordena as suas próprias continuações.

Codex usa o sandbox de leitura, sem aprovar escrita/escalada; o Claude recebe uma lista limitada de ferramentas de leitura, pesquisa, perguntas e comunicação, com hooks desativados. Os MCP/apps externos, plugins, hooks e controlo do computador/browser do Codex são desativados para a sessão ClaudeX, ficando o MCP próprio da tarefa e as ferramentas nativas de leitura/pesquisa. Na retoma, se a sessão Codex ainda estiver carregada, a HYDRAQ renova o seu processo Codex antes de carregar as novas credenciais MCP, mantendo o mesmo identificador nativo e histórico. Esta operação exige o Codex livre, sem decisões pendentes, estados incertos ou terminais HYDRAQ abertos. As configurações globais dos clientes não são alteradas. Estas restrições não são uma garantia de correção do raciocínio dos modelos.

## Validação reproduzível

- `node --test --test-concurrency=1 test/*.test.mjs`: suite completa com clientes simulados e bases temporárias.
- `node validation/claudex-ui.mjs /tmp/claudex-ui`: interface isolada com clientes simulados; requer o runtime Playwright e Chrome usados pelo projeto.
- `node validation/claudex-live.mjs --catalog`: consulta os clientes reais sem enviar pedidos aos modelos.
- `node validation/claudex-live.mjs --run`: ensaio real curto, que consome quota das duas subscrições. Cria dados e sessões próprios em `/tmp`, sem usar o servidor ativo. O ensaio exige GPT-6.1 Sol; `CX_CLAUDE_MODEL` permite escolher o modelo Claude e o valor predefinido é Opus, exigindo confirmação do catálogo como Opus 5.5.

O ensaio real investiga um contrato de importação e cria uma primeira candidata. Pausa a tarefa, fornece duas exportações de teste que contradizem o pressuposto de identidade e retoma as mesmas sessões. Verifica uma objeção fundamentada, uma segunda versão e aprovação conjunta do texto corrigido. É um cenário controlado de mudança de evidência; os ficheiros são simulados e as inferências são reais. O script guarda as provas na pasta temporária que indica; as provas selecionadas da implementação ficam em `.hydraq/claudex-2026-10-25/`.

A validação funcional não demonstra que o diálogo supera um modelo sozinho ou duas respostas independentes seguidas de síntese. Essa comparação de qualidade com o mesmo orçamento continua por realizar.

Os cartões dos participantes mostram a última mensagem do diálogo efetivamente lida e a hora dessa leitura. Registos antigos sem hora são identificados como tal. As ferramentas em execução vêm apenas do turno nativo atual; não se infere investigação a partir de um turno aberto. As instruções incentivam a partilha antecipada de descobertas verificadas e úteis, sem mensagens artificiais. Uma leitura anterior à posição independente devolve apenas os pedidos do utilizador e o próximo passo, sem revelar contribuições do colega nem registar uma leitura do diálogo.

## Na mesma conversa

Uma tarefa pedida numa conversa com histórico (`conversationId`) corre no grupo dessa conversa:
- **Participantes:** cada participante é a conversa do grupo com esse cliente: primeiro o membro do Dual, depois a própria conversa, depois a mais recente. Um cliente que o grupo não tem recebe uma conversa nova no grupo.
- **Contexto:** os pedidos da tarefa levam o que o resto do grupo disse e a sessão ainda não viu, com o mesmo mecanismo das passagens. A entrega fica registada e não se repete.
- **Condições para começar:** nenhum pedido em curso, resultado por confirmar, terminal, passagem ou decisão pendente no grupo. Durante a tarefa, pedidos normais a essas conversas são recusados.
- **Codex:** um fio já carregado mantém os servidores MCP com que foi carregado. Por isso a ligação ao Codex é renovada ao entrar (é recusada com terminais Codex abertos ou outro trabalho do Codex em curso) e, se possível, ao sair. Até lá, as ferramentas antigas só recusam.
- **Fim:** quando a tarefa termina, fica sem acordo ou é parada (também ao escolher outro modo), a conversa é devolvida depois de os dois pararem:
  - credenciais revogadas e `claudexTask` limpo;
  - modelo, raciocínio e acesso anteriores repostos;
  - uma nota no pedido seguinte de cada participante.
- **Resultado:** a resposta comum é publicada na conversa de onde foi pedida, se participou, e senão na do autor. Com aprovação dos dois, o outro participante não a volta a receber como novidade.
- **Depois de devolvida:** a tarefa não se retoma; uma nova tarefa a partir do progresso corre na mesma conversa.

Ensaio real: `node validation/hydra-inplace-live.mjs --run` (Codex Sol + agy Flash) faz Normal → Dual → Geminex → Dual → Normal numa só conversa; `CX_PARTNER=claude` faz o mesmo com ClaudeX (Codex Sol + Claude Haiku). A validação da página sem modelos é `node validation/hydra-inplace-ui.mjs`.

## Antigravity nas duplas

O agy trabalha sempre na sua conversa normal, a mesma do terminal, quer a tarefa comece numa conversa existente quer numa nova:
- **Servidor MCP:** a HYDRAQ regista uma vez o servidor `hydraq` em `~/.gemini/config/mcp_config.json` (`lib/claudex-mcp-server.mjs --route`). O agy arranca-o em todas as sessões.
- **Rota por pedido:** em cada pedido da tarefa, a HYDRAQ escreve em `~/.local/state/hydraq/agy-route/<conversa>.json` a credencial dessa ronda. O servidor encontra-a pelo identificador que o agy envia em cada chamada (`_meta["antigravity.google/root_conversation_id"]`); sem rota, as ferramentas recusam.
- **Só leitura:** o hook só de leitura deixa passar apenas as ferramentas desta tarefa no servidor `hydraq`. A rota e a regra saem no fim de cada pedido, também quando o pedido é interrompido.
- **Pausa e retoma:** pausar revoga a credencial; retomar continua na mesma conversa do agy com uma credencial nova.
- **Limite:** a proteção depende do hook da HYDRAQ, que o agy corre antes de cada ferramenta. O `--mode plan` do agy não tem efeito aqui, e não há uma barreira do sistema operativo. No Planear o agy pode ler os ficheiros que o utilizador lê, incluindo as credenciais dos outros participantes em `.hydraq/`. Não as consegue usar, porque o hook recusa endereços locais e comandos de rede. Também o Codex e o Claude conseguem ler as do agy.

**Ambiente privado antigo (retirado).** Antes da entrada 118, uma tarefa começada numa conversa nova punha o agy num ambiente `bwrap` com HOME, rede, proxy e D-Bus próprios. Esse ambiente foi retirado.
- As conversas do agy que viviam nele não continuam, nem na HYDRAQ nem no terminal.
- As tarefas onde participavam ficam **arquivadas**: não oferecem «Retomar» e deixam as conversas livres. «Nova tarefa a partir deste progresso» continua o conteúdo com sessões novas.

As tarefas antigas sem lista de participantes são interpretadas como Codex + Claude. O trio e duas instâncias do mesmo cliente não estão disponíveis.

Ensaio real dos novos pares: `node validation/claudex-pairs-live.mjs --run` usa Argon + Sol; `CX_PARTNER=claude node validation/claudex-pairs-live.mjs --run` usa Argon + Opus; `CX_AGY_MODEL=gemini-3.8-flash` troca o Argon pelo Flash. São sessões temporárias que gastam quota e usam o hook e o servidor `hydraq` da configuração do agy do utilizador.

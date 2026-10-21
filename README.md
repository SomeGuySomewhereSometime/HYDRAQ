# HYDRAQ

Interface local para os clientes originais **Codex**, **Antigravity**, **Claude Code** e **Cursor (Grok)**. Chama os executáveis locais por stdio e reutiliza as suas sessões existentes. Uma conversa pode passar de um cliente para outro entre pedidos, com passagem de contexto. Não usa proxies de modelos, APIs diretas adicionais dos fornecedores, contas alternativas ou colaboração simultânea entre agentes. O Cursor usa uma chave da própria conta Cursor, lida de um ficheiro privado.

## Abrir

Requisitos: Node.js 22 ou superior e o cliente que pretendes usar: Codex autenticado com ChatGPT (`codex login status`), Antigravity CLI autenticado (`agy models`) ou Claude Code autenticado com uma subscrição claude.ai (`claude auth status`). O Cursor requer o CLI original `agent` com ACP e o ficheiro privado descrito abaixo. Cada cliente funciona mesmo que os outros estejam indisponíveis. Não é necessário instalar Gemini CLI.

Abre `HYDRAQ.desktop` nesta pasta. O atalho inicia o serviço local e abre o browser; alguns ambientes Linux pedem que marques o atalho como fiável na primeira utilização. Também podes executar `./scripts/launch.sh` ou `npm start` e abrir <http://127.0.0.1:4318>.

O HYDRAQ só escuta em `127.0.0.1`. Não precisa de alojamento remoto. A inferência continua a ser feita pelo serviço do cliente escolhido, através da tua conta e dos limites do teu plano.

## Utilizar

1. Abre **Nova conversa** e escolhe **Cliente original**: Codex, Antigravity, Claude Code ou Cursor. Confirma que aparece ligado.
2. Indica o caminho absoluto do projeto e escolhe modelo, raciocínio e modo de acesso. No Antigravity, Executar usa as permissões do CLI, Aceitar edições usa `--mode accept-edits` e Planear usa o modo `plan`. Este modo não é apresentado como sandbox de ficheiros só de leitura.
3. Envia o pedido. O cliente original recebe o contexto e as instruções do projeto, utiliza as suas ferramentas e apresenta progresso e resultado.
4. No Codex, Claude Code e Cursor, responde aos pedidos de autorização na conversa. No Cursor aparecem também perguntas com opções e planos para rever. O Antigravity headless segue a política nativa e recusa ações que exigem uma confirmação indisponível. **Parar** interrompe o processo/turno em execução.
5. Abre uma conversa guardada para continuar. Entre pedidos podes mudar **modelo, raciocínio e acesso**, mantendo a mesma sessão e o histórico. A escolha só é aplicada quando envias o próximo pedido. O projeto fica associado à conversa. Para continuar noutro cliente, muda **Cliente original** entre pedidos (ver abaixo).

## Antigravity original: Gemini e Claude

A integração executa `agy --input-format stream-json --output-format stream-json --disable-slash-commands`, com `--sandbox` (e `--mode accept-edits` ou `--mode plan` quando escolhido) e um modelo exato do catálogo devolvido por `agy models`. Gemini, Claude Opus/Sonnet e outros modelos nativos disponíveis nessa conta aparecem automaticamente, limpando sequências ANSI/spinners do terminal e agrupando níveis de raciocínio derivados dos slugs anunciados pelo próprio CLI. Não há mudança automática para outro modelo.

Com as mesmas escolhas, os pedidos seguintes reutilizam o processo e a conversa. Ao mudar modelo/raciocínio ou abrir outra conversa Antigravity, o processo inativo é fechado e o seguinte recebe `--conversation` com o ID original. Depois de reiniciar o HYDRAQ, o próximo pedido retoma igualmente esse ID. Só se mantém um processo de conversa Antigravity aquecido de cada vez. Isto preserva o histórico nativo; não promete manter cache entre processos ou modelos.

A sessão é a do CLI original. Se não estiver autenticado, abre `agy` e inicia sessão aí; o HYDRAQ não apresenta um login Google próprio nem lê credenciais. Verifica `useG1Credits` antes de ligar e de cada envio: se estiver ativo, bloqueia o pedido e pede para o desativar no CLI, sem editar configurações globais. Esta versão aceita o catálogo nativo, sem modelos personalizados configurados com API. Não compra créditos nem subscrições.

O protocolo documentado não aceita mensagens de controlo para autorizações ou steer. Por isso, **Orientar** só aparece no Codex. Ações que precisam de autorização indisponível seguem a recusa nativa (identificada na atividade do pedido); não se ativa `--dangerously-skip-permissions`. O modo Executar pode ler/escrever no projeto segundo as políticas existentes do CLI; Aceitar edições usa `accept-edits` e Planear usa o modo nativo de planeamento. Os contadores do Antigravity mostram a diferença nativa por pedido e os totais cumulativos da sessão, sem os converter nas métricas/cache do Codex. Respostas, edições de ficheiros, pesquisas web, delegação em subagentes e comandos são mostrados em tempo real; não se promete reproduzir todos os painéis ou artefactos da aplicação Antigravity.

Fontes: [modo headless e sessões](https://antigravity.google/docs/cli/headless/), [modelos](https://antigravity.google/docs/models), [créditos do CLI](https://antigravity.google/docs/cli/credits/).

## Claude Code original

A integração executa `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio`, com `--model`, `--effort` e `--permission-mode` (`default`, `acceptEdits` ou `plan`). O catálogo e a conta vêm da resposta `initialize` do próprio CLI, sem enviar nenhum pedido ao modelo; só se aceita uma subscrição claude.ai (`firstParty`). Variáveis de chaves API, `ANTHROPIC_BASE_URL` e Bedrock/Vertex/Foundry são removidas do ambiente do processo filho. Não se usa `--dangerously-skip-permissions` nem modelos de recurso.

A sessão nativa recebe um ID escolhido pelo HYDRAQ (`--session-id`) no primeiro pedido e é retomada com `--resume` ao mudar de modelo/raciocínio, ao trocar de conversa ou depois de reiniciar o HYDRAQ. Com as mesmas escolhas, o processo fica aquecido. As autorizações (`can_use_tool`) aparecem na conversa como no Codex; **Parar** envia `interrupt` nativo e mantém a sessão. O consumo por pedido mostra entrada, cache lida, escrita em cache e saída comunicadas pelo CLI.

Limites verificados com o Claude Code 2.1.304: uma mensagem enviada durante o turno fica em fila como pedido seguinte, por isso não há **Orientar**; `AskUserQuestion` está desativado até haver um protocolo de resposta validado. Se o projeto tiver `AGENTS.md` e não tiver `CLAUDE.md`, o processo recebe uma indicação para ler `AGENTS.md`, sem criar ficheiros. Hooks, plugins e MCP configurados no teu Claude Code continuam ativos.

## Cursor original: Grok por ACP

O adaptador usa `agent --sandbox enabled acp` por stdio/JSON-RPC, com sessões independentes (`session/new`/`session/load`). Só apresenta os Grok anunciados por `cursor/list_available_models`; os IDs dos parâmetros vêm do catálogo nativo. Contexto **500K por defeito onde disponível**, com seletor 256K/500K; **Fast desligado por defeito**, com opção para ligar. Contexto, Fast, modelo, raciocínio e modo ficam registados por pedido e aplicam-se ao próximo turno, conservando o ID. Uma mudança não suportada é recusada antes de enviar o pedido; não há substituição silenciosa de modelo ou opções.

O contexto é o limite anunciado pelo modelo, não uma garantia de que todas as mensagens continuem sem compactação. Fast usa a opção nativa e pode consumir mais utilização. Não foram confirmados contadores de tokens/cache pelo ACP; a interface indica que estão indisponíveis, sem os estimar. Consumo e condições seguem a tua conta Cursor; o HYDRAQ não altera faturação nem compra créditos.

### Chave privada e arranque pelo atalho

Cria uma pasta privada `~/.config/hydraq` com modo `700` e um ficheiro `cursor.env` com modo `600`, ambos do teu utilizador. Quando `XDG_CONFIG_HOME` estiver definido, usa `$XDG_CONFIG_HOME/hydraq/cursor.env`. O ficheiro deve conter uma única linha `CURSOR_API_KEY=valor`, sem aspas, `export`, expansão de variáveis ou outras linhas (é permitida a quebra de linha final). Não uses ligações simbólicas nem coloques a chave no projeto ou no chat.

Só o adaptador lê o ficheiro, usando o descritor da pasta e `O_NOFOLLOW`. A chave entra apenas no ambiente do processo Cursor, sem a escrever em `process.env`, argumentos, histórico ou logs. O arranque remove variáveis de autenticação Cursor herdadas; os restantes adaptadores também as descartam. O ficheiro privado é a única origem aceite. Sem configuração válida, só o Cursor fica desligado e mostra a causa. Não se executa `authenticate` nem se abre um login de browser. `agent status` não é usado como prova: a ligação exige catálogo e uma sessão vazia autenticada, sem inferência.

### Autorizações, perguntas e resultados incertos

As opções de `session/request_permission` são encaminhadas sem inventar autorizações. `cursor/ask_question` apresenta as opções nativas (incluindo escolha múltipla); `cursor/create_plan` apresenta o plano e permite aceitar/rejeitar. Aceitar um plano mantém as permissões das ferramentas. Recarregar a página volta a mostrar o pedido pendente no servidor. Respostas duplicadas ou antigas são recusadas; **Parar** cancela os pedidos pendentes e envia `session/cancel`. Métodos ainda não suportados recebem uma resposta explícita, sem conceder acesso.

Depois de uma queda ou reinício durante um turno, conservam-se o ID, a saída pública parcial e as ações observadas, com estado incerto; perguntas antigas expiram e nada é reenviado. A recuperação segue a confirmação explícita já existente para continuar noutro cliente. A sessão incerta continua bloqueada. Não há orientação do turno ativo (`steer`). Planear e Perguntar são modos nativos: **não há prova de isolamento do sistema operativo no ACP**. Embora se envie a opção de sandbox, o ensaio do headless neste sistema não conseguiu iniciá-la; não se apresentam esses modos como garantia equivalente ao sandbox do Codex.

Configuração e sessões nativas Cursor ficam em `.hydraq/cursor/native`, com política inicial `allowlist`, sem alterar a configuração global do CLI. As listas de autorizações que o próprio CLI gravar nesse espaço são conservadas nos arranques seguintes. O texto de raciocínio interno não é incluído no histórico ou na passagem de contexto.
Uma edição dentro do projeto pode concluir sem diálogo: a UI encaminha os pedidos de autorização que o CLI efetivamente emitir, não exige uma confirmação por edição. As listas permanentes que o CLI guardar são conservadas; a persistência real de «Permitir sempre» ainda precisa de validação. Os cartões apresentam os argumentos, caminhos e diferenças disponíveis no pedido nativo.

Referência: [Cursor ACP](https://cursor.com/docs/cli/acp). Provas privadas da implementação em `.hydraq/cursor-integration-2026-10-21/`.

## Projetos e organização das conversas

Usa **＋ Novo projeto** para registar um nome e uma pasta local existente. O HYDRAQ valida o caminho real; uma pasta só pode ter um projeto, incluindo os arquivados. O nome é editável e a pasta fica fixa. Não são movidos ficheiros nem criados repositórios ou instruções adicionais.

- Expande um projeto na barra lateral e usa **＋ Conversa**. **Abrir** mostra a página do projeto. Em ecrãs estreitos, usa **☰ Projetos** para abrir a navegação.
- **Sem projeto** mantém as conversas soltas, com a sua própria pasta de trabalho. Ao escrever uma pasta compatível, a interface sugere um projeto existente; aceitar a sugestão cria a próxima conversa na raiz desse projeto. Podes manter a conversa solta.
- As conversas antigas não são associadas automaticamente. Usa **Organizar existentes**, escolhe o projeto e revê as conversas compatíveis antes de selecionar e guardar. Uma conversa numa subpasta pode pertencer ao projeto da pasta superior. Projetos encaixados não reorganizam as associações já guardadas.
- O menu **⋯** de uma conversa permite renomear, associar/retirar de um projeto e arquivar/restaurar. A operação abrange o grupo inteiro de sessões nativas ligadas pelas passagens; IDs, pasta de execução, histórico e anexos mantêm-se. Pastas divergentes ou incompatíveis são recusadas.
- As definições do projeto permitem escolher o cliente inicial e modelo/raciocínio por cliente; no Cursor, contexto e Fast. Aplicam-se apenas a conversas novas, sem conceder permissões. Escolhas explícitas do rascunho têm prioridade. Um modelo indisponível exige uma escolha válida, sem substituição automática.
- Texto e imagens por enviar ficam separados por conversa e, nas conversas novas, por projeto. Mudar o cliente conserva o texto/imagens; as definições são guardadas por cliente. Uma orientação continua ligada ao turno original. Estes rascunhos vivem na página e não sobrevivem ao recarregamento.
- **Arquivados** permite recuperar projetos e conversas. Não se arquiva durante uma tarefa, uma decisão pendente ou a preparação do envio. Um aviso global permite voltar à tarefa ativa ao navegar noutro projeto. Arquivar não apaga dados nem ficheiros.
- A pesquisa encontra nomes de projetos e títulos de conversas. Conversas de um projeto partilham ficheiros, mas não recebem automaticamente as mensagens/contexto umas das outras. Mantém-se uma tarefa de cada vez em toda a aplicação.

O catálogo privado `.hydraq/projects.json` guarda a organização por grupo, separado dos quatro históricos. Usa gravação atómica, fila, revisão e cópia anterior válida em `projects.json.previous`. Uma alteração feita a partir de uma revisão antiga é recusada sem perder o formulário. Se o catálogo estiver inválido, o histórico continua disponível para consulta e o original é conservado; novos envios e operações de organização ficam bloqueados até recuperação explícita. Para recuperar, encerra o serviço, conserva o original e compara-o com a cópia anterior antes de escolher o ficheiro a restaurar. Não há restauro automático.

Uma pasta indisponível ou que passou a apontar para outro caminho bloqueia novos pedidos, conservando as conversas para consulta. Não é feita uma retoma noutra pasta. Várias raízes por projeto, memória partilhada, revisão paralela e delegação automática ficam para uma versão posterior.

## Enviar imagens

Na caixa da conversa, usa **＋ Imagem**, cola com **Ctrl+V** ou arrasta os ficheiros para a caixa. Podes enviar só imagens ou juntar texto. Antes de enviar, clica numa miniatura para ampliar ou em **×** para a remover. Os rascunhos ficam associados à conversa enquanto a página estiver aberta; se um envio falhar, conservam-se para revisão.

- Até **quatro imagens por mensagem**, **5 MB por imagem**, em PNG, JPEG ou WebP estático; máximo de 8192 px por lado e 20 megapíxeis. GIF, SVG e outros documentos não fazem parte desta implementação.
- As imagens enviadas ficam privadas em `.hydraq/attachments/`, associadas ao grupo da conversa. O histórico guarda referências e apresenta miniaturas após recarregar. Não apagues essa pasta se quiseres conservar os originais.
- Codex recebe imagens locais; Claude Code e Cursor recebem blocos nativos de imagem. O Antigravity recebe texto com os caminhos e acesso adicional apenas à pasta dos anexos desse grupo; tem de abrir as imagens com a sua ferramenta nativa (`read_file`/`view_file`). Não se envia um bloco `image` ao stream-json do agy.
- Ao mudar de cliente, os originais ainda não entregues acompanham o contexto, mesmo que uses um resumo. Ao regressar, mantém-se a sessão nativa. Uma entrega admite até 16 imagens e 20 MB no total; ultrapassar o limite bloqueia o envio com explicação, sem omissões silenciosas.
- Os anexos entram em **novos pedidos**. A orientação de um turno já em curso continua a aceitar apenas texto. Nenhum resultado incerto é reenviado automaticamente.

Validação real dos quatro clientes, passagem e interface em `.hydraq/images-2026-10-21/VALIDACAO.md`. A automatização do seletor de ficheiros no Chrome exige a opção «Allow access to file URLs» da extensão; isso é uma restrição da ferramenta de teste, independente da escolha manual de ficheiros pelo utilizador.

## Continuar noutro cliente

Numa conversa parada, escolhe outro **Cliente original** e envia o pedido. O HYDRAQ liga as conversas num só fio: cada cliente mantém a sua sessão nativa, e a interface mostra tudo numa linha temporal, com o cliente que respondeu a cada mensagem.

- **Passagem completa** (predefinida): o cliente de origem faz primeiro um pedido extra a resumir objetivo, restrições, decisões, trabalho feito, pendentes e riscos. Este pedido conta na quota desse cliente. O HYDRAQ compara hashes do conteúdo antes e depois; se detetar alterações ou uma inspeção incompleta, bloqueia o envio ao destino. Não desfaz alterações. A inspeção abrange ficheiros rastreados e não ignorados pelo Git; sem Git percorre a pasta. Exclui `.git`, `.hydraq`, `node_modules` e ambientes/cache Python; tem limites de 10 000 ficheiros, 256 MiB e tempo de inspeção. Não garante ausência de alterações fora deste âmbito.
- **Passagem rápida**: sem pedido extra; segue só o que o HYDRAQ observou.
- Em ambos os casos o destinatário recebe também os teus pedidos e orientações (com o estado de entrega), as respostas finais, os ficheiros e comandos observados (com o código de saída quando comunicado), erros, recusas e o estado `git status --porcelain` do momento. O Antigravity conserva a resposta nativa completa mesmo quando é apresentada em vários blocos. Se um pedido for interrompido ou ficar incerto antes do resultado nativo, seguem todos os blocos públicos disponíveis, identificados como resposta parcial. O resumo do modelo é identificado como declarado e não verificado. O contexto enviado pode ser consultado na mensagem.
- Ao voltar a um cliente que já participou, retoma-se a sua sessão original e envia-se apenas o que aconteceu desde então. Uma passagem só conta como entregue quando o pedido do destinatário é concluído; falhas e interrupções não a confirmam. Uma passagem pendente após reinício fica assinalada como falhada, sem reenvio automático. **Parar** também cancela uma passagem ainda a preparar o resumo.
- Os factos são recolhidos à medida que chegam as ações, independentemente do limite de 200 ações visíveis. Só edições concluídas entram como ficheiros alterados; as recusas ficam contadas à parte. Os registos antigos sem resultado confirmado são identificados como tal. O limite de contexto é 40 000 caracteres (ou menos se o novo pedido ocupar o espaço restante): encurtam-se primeiro respostas e comandos, indicando omissões. Pedidos, orientações e resumos não são cortados; se o essencial não couber, o envio fica bloqueado sem marcar nada como entregue. Podes continuar na origem ou abrir uma conversa com um resumo revisto por ti.
- Por defeito conserva-se o acesso mais restrito entre origem e sessão de destino. Uma escolha explícita de acesso aplica-se também ao retomar uma sessão existente. Codex envia `sandboxPolicy` em cada `turn/start`; Antigravity e Claude reiniciam o processo com o novo modo e retomam o mesmo ID. Raciocínio interno e cache não passam entre clientes.
- Um resultado incerto bloqueia o grupo até reveres o projeto e escolheres **Verifiquei o estado · permitir continuar noutro cliente**. Essa confirmação fica guardada, sem transformar o resultado em concluído. Depois podes continuar noutro cliente pela passagem rápida, que inclui o aviso, os pedidos e os resultados parciais; a sessão nativa incerta continua bloqueada. Uma nova incerteza exige nova confirmação.

Se o contexto essencial for demasiado grande, aparece **Rever contexto demasiado grande**, incluindo quando tentas continuar numa sessão de destino já existente. Escreve um resumo revisto por ti (até 12 000 caracteres) com as instruções, restrições, resultados e pendentes relevantes. Guardá-lo não envia um pedido: o resumo substitui explicitamente os registos abrangidos na próxima passagem. O histórico original permanece intacto; novos pedidos de outros clientes continuam a entrar e os avisos de resultados incertos não podem ser apagados pelo resumo. Só uma resposta concluída confirma a entrega. Podes também regressar ao cliente de origem.

Em projetos Unity reconhecidos sem Git (com `Assets` e `ProjectSettings/ProjectVersion.txt`), a inspeção ignora as pastas geradas `Library`, `Temp`, `obj` e `Logs` na raiz. Continua a verificar o código e mantém os limites explícitos. Com Git, seguem-se os ficheiros rastreados e não ignorados; uma pasta genérica chamada `Library` continua incluída.

As ferramentas observadas dos subagentes Claude entram nos factos da passagem e na atividade, identificadas como subagentes; o seu texto interno não entra no chat. A atividade agrega os clientes do grupo. **Parar** também funciona durante a preparação: um pedido cancelado antes de ser enviado não inicia inferência.

## Histórico e recuperação de ficheiros

Cada cliente mantém `state.json` e uma cópia válida anterior `state.json.previous`, atualizada no máximo uma vez por minuto. A gravação usa um ficheiro temporário e troca atómica. Se um histórico não puder ser carregado, só esse cliente fica indisponível: o original é preservado e os outros continuam a funcionar. O fecho não grava por cima do cliente que falhou.

A aplicação não restaura automaticamente uma cópia antiga, porque ela pode não conter um pedido já entregue ao cliente nativo. Para recuperar, encerra o HYDRAQ, guarda uma cópia do ficheiro problemático e compara-o com `state.json.previous` antes de escolher o que restaurar. Revê as sessões nativas e os possíveis efeitos no projeto; uma cópia anterior não prova que os pedidos seguintes não chegaram a correr.

## Progresso e orientação durante a execução

O cartão de progresso mostra a ação em curso, os comentários públicos do cliente e as ações observadas neste pedido. Abre **Ver ações deste pedido** para consultar o que já terminou ou falhou. Quando o Codex publica um plano nativo, aparecem também os passos e os estados fornecidos por ele. Nem todos os pedidos produzem um plano; não são inventados passos, percentagens ou atualizações por chamadas adicionais ao modelo.

Durante um turno ativo, escreve na caixa da conversa e usa **Orientar ↗** para acrescentar uma instrução ao mesmo turno. Por exemplo: “Foca-te primeiro nos erros de autenticação”. A orientação usa `turn/steer` do Codex original e mantém a sessão, o modelo e o raciocínio desse pedido. Não desfaz ações já executadas e não substitui uma autorização pendente. O botão **Parar** continua disponível.

A orientação fica identificada no histórico como **A enviar orientação…**, **Recebida pelo Codex no mesmo turno**, **Orientação não entregue** ou **Entrega não confirmada**. Recebida confirma a entrega ao Codex; não garante que todas as instruções possam ser aplicadas. Se a ligação falhar ou faltar confirmação, não há reenvio automático. O histórico conserva esse estado após reinício.

Um rascunho iniciado como orientação fica associado ao turno original. Se esse turno terminar antes do envio, o texto mantém-se na caixa e o envio fica bloqueado. Podes limpá-lo ou escolher explicitamente **Usar como novo pedido**. A validação do identificador do turno no servidor também impede que uma orientação atrasada inicie outro pedido.

Referência: [orientar um turno ativo no App Server](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn).

## Raciocínio e cache no Codex

O painel de configuração distingue os modelos que anunciam suporte para atualizar o raciocínio conservando o prefixo, os que não o anunciam e os casos sem informação confirmada. A indicação vem do campo nativo `supports_reasoning_effort_updates`, num catálogo recente e da mesma versão do executável; não é inferida do nome do modelo. A capacidade de execução é confirmada por `experimentalFeature/list`.

O processo HYDRAQ ativa `features.reasoning_effort_override` apenas no seu processo Codex e nas suas sessões. Essa opção ainda é experimental; permite ao motor original usar `configuration_update` nos modelos suportados. Não são injetados itens manualmente, alteradas configurações globais ou feitas chamadas diretas à API OpenAI. Mantêm-se a velocidade normal e o modo de um agente.

**Conservar o prefixo não garante que a cache continue disponível.** Mudar de modelo mantém a sessão, mas pode impedir a reutilização da cache anterior. Em cada pedido ficam registados o modelo e o raciocínio solicitados. As respostas novas apresentam essa identificação; o histórico antigo é preservado sem atribuições retroativas inventadas.

O consumo por pedido mostra entrada, entrada em cache, entrada sem cache, saída e percentagem reutilizada. É calculado a partir da diferença dos totais cumulativos comunicados pelo Codex, incluindo as chamadas internas do pedido; o campo nativo `last` corresponde ao último passo e não deve ser confundido com todo o pedido. Sem contadores suficientes, ou se forem reiniciados, a interface indica que a medição não está disponível. Estes valores não são uma conversão para a quota da subscrição.

Referências: [mudar raciocínio durante a conversa](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation) e [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

O catálogo é fornecido pelo Codex; aparecer na lista não prova que um modelo aceite pedidos nessa conta. Não há mudança automática de modelo. Se uma ligação terminar a meio, o HYDRAQ não repete a tarefa. A sessão incerta fica bloqueada; podes abrir uma conversa nova para inspecionar o projeto ou confirmar a inspeção e continuar noutro cliente como descrito acima.

## Estado e permissões

O histórico Codex da interface mantém-se em `.hydraq/state.json`; o Antigravity usa `.hydraq/antigravity/state.json` o Claude Code `.hydraq/claude/state.json` e o Cursor `.hydraq/cursor/state.json`. As ligações entre conversas e as passagens ficam guardadas nessas mesmas conversas, sem migração. Todos têm permissões restritas e ficam excluídos do Git. As sessões originais são também guardadas pelos respetivos clientes nos locais habituais. O HYDRAQ não lê credenciais dos outros clientes; no Cursor lê apenas o ficheiro privado fornecido pelo utilizador. Não modifica login ou configurações globais. Os processos originais precisam de escrever no seu próprio diretório de estado.

No Codex, o fornecedor é fixado em `openai`, a autenticação tem de ser `chatgpt` e a velocidade usada é a normal. Variáveis de chaves API são removidas do ambiente do processo filho. O HYDRAQ não compra créditos nem passa para API paga; aplicam-se os limites e as opções de consumo que já estejam associadas à tua conta ChatGPT. Os MCP que configurares podem ter condições de consumo próprias.

Só há uma tarefa em execução de cada vez, entre todos os clientes, incluindo o pedido de resumo de uma passagem. No Codex, o acesso de escrita fica limitado ao projeto pelo sandbox e os pedidos adicionais são apresentados ao utilizador. Os MCP mantêm as suas próprias permissões. A interface não fornece o browser integrado desta aplicação Codex nem as suas ferramentas específicas de gestão de chats. Pedidos RPC ainda não suportados são recusados, sem conceder permissões automaticamente.

O App Server é experimental: o protocolo foi conferido com Codex CLI **0.159.0**. Falhas de autenticação, políticas ou incompatibilidades aparecem na interface. Reiniciar o servidor não reenvia tarefas.

## Desenvolvimento

Sem dependências npm externas. `npm test` verifica transporte, histórico, autenticação, interrupção, autorizações, progresso, orientação no mesmo turno e proteção dos rascunhos, com processos originais simulados de Codex, Antigravity, Claude Code e Cursor, e a passagem entre clientes. Inclui políticas por turno, mudanças de acesso na mesma sessão, limites sem perda de pedidos, mais de 200 ações, recusas, resposta nativa completa, hashes de ficheiros, cancelamento, falhas de persistência, recuperação de resultados incertos, duplicados e reinício. O estado atual, as alterações, os testes e as limitações conhecidas ficam registados em [AI_CHANGES.md](AI_CHANGES.md).

`HYDRAQ_PORT` escolhe outra porta; `HYDRAQ_DATA_DIR` escolhe o diretório do histórico. `HYDRAQ_CODEX_BIN`, `HYDRAQ_AGY_BIN`, `HYDRAQ_CLAUDE_BIN` e `HYDRAQ_CURSOR_BIN` permitem indicar os executáveis originais. `npm run dev` reinicia o servidor quando o código muda; não o uses durante uma tarefa importante.

Para terminar o serviço iniciado pelo atalho, consulta o PID em `/health` e envia-lhe `SIGTERM`. Num terminal com `npm start`, usa Ctrl+C.

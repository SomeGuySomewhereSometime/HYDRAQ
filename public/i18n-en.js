import { coreEnglish } from './i18n-core-en.js';
import { mainEnglish } from './i18n-main-en.js';
import { settingsEnglish } from './i18n-settings-en.js';
import { teamEnglish } from './i18n-team-en.js';
export const english = Object.fromEntries(`
Pedido para o {0}|Request for {0}
● {0} ligado|● {0} connected
○ {0} desligado|○ {0} disconnected
◌ A ligar ao {0}…|◌ Connecting to {0}…
{0} está desativado. Podes ativá-lo ou escolher outro cliente.|{0} is disabled. You can enable it or choose another client.
{0} · desativado nas Configurações.|{0} · disabled in Settings.
{0} · indisponível|{0} · unavailable
{0} clientes|{0} clients
{0} modelos disponíveis|{0} available models
Raciocínio · {0}|Reasoning · {0}
{0} tokens · sessão|{0} tokens · session
{0} ações em curso|{0} actions in progress
Definições de {0}|Settings for {0}
Mensagem para {0}…|Message for {0}…
Tu · para o {0}|You · to {0}
Tu · para {0}|You · to {0}
Continuação no {0}|Continuation in {0}
Copiar código · {0}|Copy code · {0}
Enviar só ao {0} ↗|Send only to {0} ↗
Só para o {0}|Only to {0}
{0} · principal · implementação|{0} · primary · implementation
{0} · mantém a sessão desta conversa|{0} · keeps this conversation's session
{0} entrou na conversa|{0} joined the conversation
{0} saiu da conversa|{0} left the conversation
{0} precisa da tua autorização|{0} needs your approval
Pasta: {0}|Folder: {0}
Caminho: {0}|Path: {0}
Acesso adicional: {0}|Additional access: {0}
Raciocínio e atividade · {0} {1}|Reasoning and activity · {0} {1}
Largura da conversa: {0}|Conversation width: {0}
Largura da conversa: {0}.|Conversation width: {0}.
Aparência {0}|Appearance {0}
Aparência: {0}.|Appearance: {0}.
Aparência: {0}. Clica para escolher a aparência.|Appearance: {0}. Click to choose an appearance.
Assistente de voz e memória de {0}|Voice and memory assistant for {0}
{0} píxeis|{0} pixels
O conteúdo excede {0} caracteres.|The content exceeds {0} characters.
Versão atual {0}|Current version {0}
Versões anteriores ({0})|Previous versions ({0})
Importação preparada · {0} imagens|Import prepared · {0} images
Diálogo · {0} contributos e atualizações|Dialogue · {0} contributions and updates
Revisão e testes · ronda {0}|Review and tests · round {0}
Revisão: {0}|Review: {0}
Sínteses anteriores desta ronda · {0}|Previous syntheses for this round · {0}
A síntese automática não arrancou: {0}|Automatic synthesis did not start: {0}
O Multi não foi ativado: {0} Nada foi enviado.|Multi was not enabled: {0} Nothing was sent.
{0} à espera|{0} waiting
Há {0} min|{0} min ago
Há {0} h|{0} h ago
Atualizar modelos e quotas do {0}|Refresh models and quotas for {0}
Reposição prevista: {0}|Expected reset: {0}
Fala ou escreve para {0}. Os pedidos delegados e as respostas aparecem também na conversa normal.|Speak or write to {0}. Delegated requests and replies also appear in the main conversation.
Abre uma nova tarefa e novas sessões, com o progresso anterior identificado.|Open a new task and new sessions, with the previous progress identified.
Começa uma conversa nova no projeto selecionado. Atalho: N|Start a new conversation in the selected project. Shortcut: N
Começa uma conversa independente numa pasta própria.|Start an independent conversation in its own folder.
Cria um projeto com uma pasta fixa, memória própria e conversas organizadas.|Create a project with a fixed folder, its own memory and organised conversations.
Associa conversas soltas a projetos existentes.|Link standalone conversations to existing projects.
Mostra ou esconde projetos e conversas arquivados.|Show or hide archived projects and conversations.
Ver a ligação e os detalhes do cliente ativo.|View the active client's connection and details.
Arrasta para ajustar a largura · setas também ajustam · duplo clique repõe · Enter esconde|Drag to resize · arrow keys also resize · double-click to reset · Enter to hide
Deixa vazio para criar uma pasta própria fora do HYDRAQ, ou escolhe uma pasta. Fica fixa depois do primeiro pedido.|Leave empty to create a separate folder outside HYDRAQ, or choose a folder. It stays fixed after the first request.
Conversas com um cliente de cada vez, com passagem de contexto entre clientes.|Conversations with one client at a time, with context handoffs between clients.
Equipa: o Codex planeia, o Grok executa e o Claude pode rever.|Team: Codex plans, Grok executes and Claude can review.
Abrir paleta rápida de comandos, conversas, projetos e clientes (Ctrl+K)|Open the quick palette for commands, conversations, projects and clients (Ctrl+K)
Estado da ligação ao cliente escolhido.|Connection status for the selected client.
Mostrar ou esconder o último pedido, a atividade e as configurações|Show or hide the latest request, activity and settings
Mudar para Codex (OpenAI · sessão local)|Switch to Codex (OpenAI · local session)
Mudar para Antigravity (Google · agy nativo)|Switch to Antigravity (Google · native agy)
Mudar para Claude Code (Anthropic · CLI)|Switch to Claude Code (Anthropic · CLI)
Mudar para Cursor (Grok · ACP)|Switch to Cursor (Grok · ACP)
OpenCode original · só modelos gratuitos do fornecedor OpenCode|Original OpenCode · free models from the OpenCode provider only
Escolhe quando esta mensagem chega ao cliente. As opções dependem do protocolo de cada cliente.|Choose when this message reaches the client. Options depend on each client's protocol.
Raciocínio: quanto o modelo pensa antes de responder. Mais raciocínio é mais lento e consome mais utilização.|Reasoning: how much the model thinks before replying. More reasoning is slower and uses more quota.
Janela de contexto do Grok no Cursor.|Grok context window in Cursor.
Fast: respostas mais rápidas com maior consumo de utilização do Cursor.|Fast: quicker replies with higher Cursor usage.
Interrompe o pedido em curso. Ações já feitas não são desfeitas.|Interrupt the current request. Completed actions are not undone.
Os clientes originais correm no teu computador, com as suas sessões. O histórico fica guardado localmente.|The original clients run on your computer with their own sessions. History is stored locally.
Mostra consumo, atividade e sistema num único painel|Show usage, activity and system in one panel
Foca na linha temporal de comandos, ficheiros e ferramentas|Focus on the timeline of commands, files and tools
Foca nos contadores de tokens, cache e diffs do turno|Focus on the turn's token counts, cache and diffs
Mostra capacidades dos modelos, cache e disposição|Show model capabilities, cache and layout
Repõe o tamanho do texto a 15 px, sem mudar a largura ou os painéis.|Reset text size to 15 px without changing width or panels.
Ajusta o texto das perguntas, respostas e pareceres. Não altera o tamanho dos menus ou da caixa de escrita.|Adjust text in questions, replies and reviews. Does not change menus or the message box.
Volta às cores originais: Codex esmeralda, Antigravity ciano, Claude laranja, Cursor violeta e OpenCode rosa.|Restore the original colours: emerald Codex, cyan Antigravity, orange Claude, violet Cursor and pink OpenCode.
Alterna entre linhas de texto com largura confortável e a largura total da conversa. Código e tabelas usam sempre a largura disponível.|Switch between comfortable text width and full conversation width. Code and tables always use the available width.
Repõe a largura e a visibilidade dos painéis laterais.|Reset side panel widths and visibility.
Todos os clientes estão desativados. Ativa um para começar.|All clients are disabled. Enable one to start.
Não foi possível abrir a sessão local.|Could not open the local session.
A ligação ao HYDRAQ foi interrompida. A página volta a ligar automaticamente; os pedidos não são reenviados.|The connection to HYDRAQ was interrupted. The page reconnects automatically; requests are not resent.
○ Servidor indisponível|○ Server unavailable
○ Ligação local interrompida|○ Local connection interrupted
Não foi possível guardar o rascunho neste navegador. Mantém esta página aberta.|Could not save the draft in this browser. Keep this page open.
Se escreveres uma pasta que ainda não existe, será criada ao guardar.|If you enter a folder that does not exist, it will be created when you save.
Cliente desativado nas Configurações|Client disabled in Settings
Codex original · sessão ChatGPT existente|Original Codex · existing ChatGPT session
Claude Code original · sessão claude.ai existente|Original Claude Code · existing claude.ai session
Sessão do agy · quota do plano|agy session · plan quota
Conta do Cursor · autenticação privada|Cursor account · private authentication
Não há confirmação suficiente para este modelo nesta ligação. A sessão mantém-se; não se garante a reutilização da cache ao mudar o raciocínio.|There is insufficient confirmation for this model on this connection. The session is kept; cache reuse when changing reasoning is not guaranteed.
As permissões de rede e ferramentas são geridas pelo cliente. Planear pode ser escolhido no compositor.|Network and tool permissions are managed by the client. Plan can be selected in the composer.
Perfil do próximo pedido. O servidor verifica os limites antes de enviar.|Profile for the next request. The server checks limits before sending.
Só no próximo pedido|Only for the next request
Dar opinião|Give an opinion
Pedir opinião|Request an opinion
Pedir outra resposta|Request another answer
Pedir síntese parcial|Request a partial synthesis
Resposta inicial e revisão|Initial response and review
Escolhe um modelo|Choose a model
Abrir projeto|Open project
Abrir tarefa|Open task
Abrir tarefa anterior|Open previous task
Abrir ficheiro do plano|Open plan file
Abrir mascote do projeto (Live)|Open project mascot (Live)
Abrir no separador Hydra|Open in the Hydra tab
Abrir o assistente|Open assistant
Abrir pedido e resposta na conversa|Open request and reply in the conversation
Abrir página solicitada|Open requested page
Tu|You
TU|YOU
passo|step
passos|steps
enviado|sent
enviados|sent
selecionado|selected
selecionados|selected
livre|available
grátis|free
não medido|not measured
não comunicado|not reported
ação concluída|completed action
ações concluídas|completed actions
ação com erro|failed action
ações com erro|failed actions
ação recusada|rejected action
ações recusadas|rejected actions
delegação|delegation
novo requisito para o|new requirement for
para o|to
Decisão pendente|Decision pending
Tarefa em curso|Task in progress
Revisor em curso ou decisão pendente|Reviewer running or decision pending
Ciclo em curso|Cycle in progress
Aguarda a tua decisão|Waiting for your decision
Manter|Keep
Rever|Review
Modificar|Modify
Corrigir|Fix
Implementação|Implementation
Planeamento|Planning
HYDRAQ · Agentes locais|HYDRAQ · Local agents
Projetos e conversas|Projects and conversations
HYDRAQ início|HYDRAQ home
Nova conversa|New conversation
＋ Nova conversa|＋ New conversation
＋ Conversa sem projeto|＋ Conversation without a project
＋ Novo projeto|＋ New project
Pesquisar projetos e conversas|Search projects and conversations
Pesquisar projetos e conversas…|Search projects and conversations…
PROJETOS E CONVERSAS|PROJECTS AND CONVERSATIONS
Conversas guardadas|Saved conversations
Organizar existentes|Organise existing conversations
Arquivados|Archived
A carregar modelo…|Loading model…
A verificar sessão…|Checking session…
Largura dos projetos|Projects panel width
Fechar projetos|Close projects
Mostrar ou esconder projetos e conversas|Show or hide projects and conversations
Projetos|Projects
Pasta de trabalho|Working folder
Pasta automática para esta conversa|Automatic folder for this conversation
Escolher pasta de trabalho|Choose working folder
Escolher pasta|Choose folder
Uma tarefa. Todo o contexto.|One task. All the context.
Passagem|Handoff
Rápida|Quick
Completa · resumo|Full · summary
Áreas da aplicação|Application areas
Conversas|Conversations
Colaboração|Collaboration
Comandos|Commands
Escolher a aparência|Choose appearance
A ligar ao Codex…|Connecting to Codex…
Painel de atividade|Activity panel
Projeto|Project
Resultado por confirmar|Unconfirmed result
Rever contexto da passagem|Review handoff context
Progresso da tarefa|Task progress
Hydra · tarefa conjunta|Hydra · joint task
DA IDEIA À EXECUÇÃO|FROM IDEA TO EXECUTION
O que vamos|What shall we
construir hoje|build today
Os clientes originais, num espaço teu.|The original clients, in your own workspace.
Escolhe o cliente, o modelo e o raciocínio na caixa de mensagens.|Choose the client, model and reasoning in the message box.
Motores locais disponíveis|Available local engines
Sessão nativa ChatGPT|Native ChatGPT session
Gemini & Claude nativos|Native Gemini & Claude
Sessão claude.ai local|Local claude.ai session
ACP · GRÁTIS|ACP · FREE
Explorar o projeto|Explore the project
Rever o código|Review the code
Deteta riscos, bugs subtis e melhorias prioritárias com rigor técnico.|Find risks, subtle bugs and priority improvements with technical rigour.
Diagnosticar testes|Diagnose tests
Avalia cobertura, casos limite e estabilidade da suite de verificação.|Assess coverage, edge cases and test suite stability.
Traçar plano de execução|Plan the implementation
Desenha etapas verificáveis antes de avançar para a implementação.|Define verifiable steps before implementation.
Pedidos do Codex|Codex requests
Escolher agente ativo|Choose active agent
Grátis|Free
Mensagens em fila|Queued messages
Mensagem durante a execução|Message during execution
↳ Mensagem durante a execução|↳ Message during execution
Quando entregar a mensagem|When to deliver the message
A orientação mantém o pedido atual.|Guidance keeps the current request.
Usar como novo pedido|Use as a new request
Pedido para o Codex|Request for Codex
Descreve o que queres fazer…|Describe what you want to do…
Opções do próximo pedido|Next request options
Destinatário do pedido|Request recipient
Cliente|Client
Clientes|Clients
Modelo|Model
A carregar modelos…|Loading models…
Raciocínio|Reasoning
Automático|Automatic
Contexto|Context
Escolher revisor automático|Choose automatic reviewer
Revisor · Desligado|Reviewer · Off
Revisor|Reviewer
Planear|Plan
Permissões|Permissions
Só leitura|Read only
■ Parar|■ Stop
Parar|Stop
Criar ponto de segurança|Create checkpoint
Enviar|Send
Enviar ↗|Send ↗
Enter para enviar · Shift + Enter para nova linha|Enter to send · Shift + Enter for a new line
Terminal original|Original terminal
◉ Execução local · sessão original|◉ Local execution · original session
Largura do painel de atividade|Activity panel width
Último pedido, atividade e configurações|Latest request, activity and settings
Vista do painel lateral|Side panel view
Tudo|All
Atividade|Activity
Consumo|Usage
Sistema|System
Conteúdo do painel lateral|Side panel content
Limites dos modelos selecionados|Selected model limits
Consumo do último pedido|Latest request usage
Modo do próximo pedido|Next request mode
Dupla Hydra|Hydra pair
Proteções do próximo pedido|Next request protections
Filtrar atividade|Filter activity
O trabalho aparece aqui.|Work appears here.
Comandos, ferramentas e alterações,|Commands, tools and changes,
à medida que acontecem.|as they happen.
Ver alterações|View changes
Configurações e detalhes|Settings and details
Aplicam-se a todos os projetos deste HYDRAQ.|Apply to all projects in this HYDRAQ.
Chave para a voz Live da mascote, em todos os projetos.|Key for the mascot's Live voice, across all projects.
Chave API|API key
Colar chave API|Paste API key
Guardar chave|Save key
Remover chave|Remove key
Guardada apenas neste computador. Aplica-se à próxima ligação Live.|Stored only on this computer. Applies to the next Live connection.
Próximo pedido|Next request
Cada cliente usa a sua sessão original.|Each client uses its original session.
Aplicam-se ao próximo pedido.|Apply to the next request.
Sessão no Codex original|Session in the original Codex
Sessão no Claude original|Session in the original Claude
Sessão no OpenCode original|Session in the original OpenCode
Sessão no Antigravity original|Session in the original Antigravity
Comparar suporte dos modelos|Compare model support
As autorizações adicionais aparecem na conversa.|Additional approval requests appear in the conversation.
Aparência|Appearance
Texto da conversa|Conversation text
Repor|Reset
Tamanho|Size
Só neste browser · aplicado ao histórico todo.|Only in this browser · applies to all history.
Cores dos clientes|Client colours
Repor disposição|Reset layout
Pronto para começar|Ready to start
Voltar a ligar|Reconnect
Fechar painel de atividade|Close activity panel
Hydra · análise conjunta|Hydra · joint analysis
Colaboração entre modelos|Model collaboration
Paleta rápida de comandos|Quick command palette
Saltar para conversa, projeto, cliente ou executar ação…|Jump to a conversation, project or client, or run an action…
Resultados e comandos|Results and commands
navegar|navigate
executar|run
abrir/fechar|open/close
Idioma da interface|Interface language
Só neste navegador. As conversas mantêm a língua original.|Only in this browser. Conversations keep their original language.
Não foi possível guardar o idioma neste navegador.|Could not save the language in this browser.
Guardar|Save
Cancelar|Cancel
Fechar|Close
Abrir|Open
Continuar|Continue
Confirmar|Confirm
Eliminar|Delete
Apagar|Delete
Editar|Edit
Copiar|Copy
Copiado|Copied
Copiado!|Copied!
Descarregar|Download
Restaurar|Restore
Arquivar|Archive
Pesquisar|Search
Pesquisa|Search
Nome|Name
Descrição|Description
Pasta|Folder
Sem projeto|No project
Sem conversas|No conversations
Novo projeto|New project
Criar projeto|Create project
Editar projeto|Edit project
Nome do projeto|Project name
Pasta do projeto|Project folder
Criar pasta|Create folder
Nome da nova pasta|New folder name
Escolher esta pasta|Choose this folder
↑ Pasta acima|↑ Parent folder
A carregar pastas…|Loading folders…
A criar pasta…|Creating folder…
Esta pasta não contém subpastas.|This folder has no subfolders.
São apresentadas as primeiras 2000 pastas.|Showing the first 2000 folders.
Indica apenas um nome de pasta válido.|Enter a valid folder name only.
Cria um projeto ou começa uma conversa solta.|Create a project or start a standalone conversation.
＋ Conversa|＋ Conversation
Pesquisar conteúdo…|Search content…
Pesquisar conversas|Search conversations
Sem resultados.|No results.
Nenhum resultado.|No results.
A pesquisar…|Searching…
Carregar mais|Load more
Mostrar mais|Show more
Ver mais|View more
Hoje|Today
Ontem|Yesterday
Ligado|On
Desligado|Off
Pronto|Ready
Desativado|Disabled
A desligar…|Disconnecting…
A ligar…|Connecting…
Sem ligação|Disconnected
Tentar ligar|Try connecting
Tentar desligar|Try disconnecting
Gerir clientes|Manage clients
A guardar…|Saving…
Chave guardada. Será usada na próxima ligação Live.|Key saved. It will be used for the next Live connection.
A usar a chave do ambiente do servidor. Podes guardar outra aqui.|Using the server environment key. You can save another here.
Ainda não foi configurada uma chave.|No key has been configured yet.
Colar uma nova chave para substituir|Paste a new key to replace the current one
Cola a chave Google AI Studio antes de guardar.|Paste the Google AI Studio key before saving.
Chave guardada removida.|Saved key removed.
Chave Google AI Studio guardada.|Google AI Studio key saved.
Normal|Normal
Modo|Mode
Até 4 modelos|Up to 4 models
Em diálogo|In dialogue
Perfil de permissões|Permission profile
Nativo|Native
Projeto confinado|Project confined
Ronda Multi|Multi round
Estrita|Strict
Mista|Mixed
Rede dos comandos e pesquisa|Command network and search
MCP externos|External MCP
Validação dos perfis|Profile validation
Leitura e escrita|Read and write
Aceitar edições|Accept edits
Executar|Run
Leve|Low
Médio|Medium
Alto|High
Máximo|Maximum
Todos|All
Todas|All
Nenhum|None
Nenhuma|None
Sim|Yes
Não|No
Ativo|Active
Inativo|Inactive
Ativar|Enable
Desativar|Disable
Manual|Manual
Automática|Automatic
Favoritos|Favourites
Recentes|Recent
OpenCode · gratuitos|OpenCode · free
OpenCode · apenas modelos gratuitos|OpenCode · free models only
Escolher modelo|Choose model
Verificar modelos|Check models
Atualizar|Refresh
Atualizado agora|Updated just now
Todos os clientes e modelos|All clients and models
Modelo de teste|Test model
Outro modelo|Other model
Sem metadados|No metadata
Aplicam-se ao primeiro pedido.|Apply to the first request.
Nova tarefa|New task
Retomar|Resume
Pausar|Pause
Pausa|Pause
Interromper|Interrupt
Concluído|Completed
Concluída|Completed
Falhou|Failed
Em curso|In progress
A aguardar|Waiting
A preparar…|Preparing…
A enviar…|Sending…
A executar…|Running…
Em fila|Queued
Cancelado|Cancelled
Interrompido|Interrupted
Interrompida|Interrupted
Pausado|Paused
Pausada|Paused
Histórico|History
Memória|Memory
Memória do projeto|Project memory
Ver memória|View memory
Decisões|Decisions
Decisão|Decision
Preferências|Preferences
Pendentes|Pending
Resumo|Summary
Resumo acumulado|Accumulated summary
Identidade|Identity
Mascote|Mascot
Escolhe um projeto|Choose a project
Abrir mascote|Open mascot
Histórico disponível sem ligar a voz|History available without connecting voice
Mais opções|More options
Guardar decisão no projeto|Save decision to project
Resposta do modelo|Model response
Resposta dos modelos|Model responses
Exploração delegada|Delegated exploration
Só as delegações e as respostas dos modelos entram na conversa normal.|Only delegations and model replies enter the main conversation.
Voz|Voice
Voz Live|Live voice
Ligar voz|Connect voice
Desligar voz|Disconnect voice
Microfone|Microphone
Ouvir|Listen
Silenciar|Mute
Falar|Speak
Texto|Text
Ficheiros|Files
Ficheiro|File
Alterações|Changes
Testes|Tests
Resultado|Result
Resultados|Results
Plano|Plan
Revisão|Review
Revisores|Reviewers
Participantes|Participants
Principal|Primary
Executor|Executor
Aprovar|Approve
Recusar|Reject
Permitir|Allow
Permitir uma vez|Allow once
Permitir sempre|Always allow
Responder|Reply
Repetir|Retry
Tentar novamente|Try again
Voltar|Back
Seguinte|Next
Anterior|Previous
Limpar|Clear
Ver detalhes|View details
Detalhes|Details
Ver saída completa|View full output
Ver captura|View screenshot
Apagar tarefa|Delete task
Nova ronda|New round
Síntese|Synthesis
Sintetizar|Synthesise
Incorporar|Incorporate
Comparar|Compare
Renomear|Rename
Título|Title
Mensagem|Message
Mensagens|Messages
Pedido|Request
Pedidos|Requests
Conversa|Conversation
Nova conversa solta|New standalone conversation
Arquivar projeto|Archive project
Restaurar projeto|Restore project
Cliente inicial|Initial client
Usar preferência atual|Use current preference
Modelos e raciocínio por cliente|Models and reasoning by client
Usar catálogo atual|Use current catalogue
Escolher ou criar pasta|Choose or create folder
Anexar imagem|Attach image
＋ Imagem|＋ Image
Ditar mensagem|Dictate message
Selecionar imagens|Select images
Remover imagem|Remove image
Texto copiado.|Text copied.
Não foi possível copiar.|Could not copy.
Total|Total
Entrada|Input
Saída|Output
Cache|Cache
Tokens de entrada|Input tokens
Tokens de saída|Output tokens
Não medido|Not measured
Desconhecido|Unknown
Sem dados|No data
Preservação não confirmada|Preservation not confirmed
Como funciona|How it works
Largura da conversa|Conversation width
Toda|Full
Média|Medium
Estreita|Narrow
Largura total do texto|Full text width
Ardósia e grafite escovada, com barra e cor de cada cliente.|Slate and brushed graphite, with a bar and colour for each client.
Ilhas de vidro sobre obsidiana, com barra de clientes.|Glass islands on obsidian, with a client bar.
Carbono arquitetónico e acentos cromáticos por cliente.|Architectural carbon and colour accents for each client.
Ocupa toda a largura da conversa.|Uses the full conversation width.
Coluna central, um pouco mais estreita.|A slightly narrower central column.
Coluna central estreita, só para ler e escrever.|A narrow central column for reading and writing.
Esmeralda|Emerald
Lima|Lime
Âmbar|Amber
Laranja|Orange
Rubi|Ruby
Rosa|Pink
Violeta|Violet
Azul|Blue
Ciano|Cyan
Em espera|Waiting
Configurações|Settings
Sessão por verificar|Session not checked
A verificar sessão…|Checking session…
Ligação local interrompida|Local connection interrupted
Servidor indisponível|Server unavailable
Sem projeto associado|No linked project
Enviar mensagem|Send message
Abrir no terminal|Open in terminal
Associar sessão Codex existente|Link existing Codex session
Associar sessão existente|Link existing session
Libertar sessão|Release session
Sair|Exit
Data|Date
Estado|Status
Ligação|Connection
Modelos|Models
Conta|Account
Recarregar página|Reload page
Reiniciar servidor|Restart server
Sem alterações.|No changes.
Nada a mostrar.|Nothing to show.
Guardar commit|Save commit
Criar commit|Create commit
Enviar para remoto|Push to remote
Histórico Git|Git history
Ponto de segurança|Checkpoint
Retirar associação|Remove link
Sem ponto de segurança|No checkpoint
Ver diff|View diff
Selecionar todos|Select all
Limpar seleção|Clear selection
Cancelar seleção|Cancel selection
Escolher commit|Choose commit
Restaurar ficheiro|Restore file
Enviar contexto|Send context
Contexto do projeto|Project context
Incluir arquivados|Include archived
Abrir conversa|Open conversation
Ativar memória|Enable memory
Limpar memória|Clear memory
Eliminar conversa|Delete conversation
Sem histórico.|No history.
Sem memória guardada.|No saved memory.
Guardar resumo|Save summary
Adicionar|Add
Remover|Remove
Proposta|Proposal
Propostas|Proposals
Publicar|Publish
Origem|Source
Destino|Target
Pré-visualizar|Preview
Pré-visualização|Preview
Desfazer|Undo
Repor predefinições|Restore defaults
Gravar|Record
Parar gravação|Stop recording
Transcrever|Transcribe
Sem resposta|No response
Concluído.|Completed.
Guardado.|Saved.
Erro|Error
Aviso|Notice
Ajuda|Help
Ver|View
Português|Português
Inglês|English
`.trim().split('\n').map(line => line.split('|')));
Object.assign(english, coreEnglish, mainEnglish, settingsEnglish, teamEnglish);

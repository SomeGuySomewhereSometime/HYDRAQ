// App-authored text in Hydra, reviews, collaboration and Multi. Never translate participant content.
export const teamEnglish = Object.fromEntries(`
Última leitura: mensagem {0} · {1}|Last read: message {0} · {1}
Teste: {0}{1} · {2}|Test: {0}{1} · {2}
Retirar {0}{1}|Remove {0}{1}
Resultado aprovado aplicado · {0} {1}.|Approved result applied · {0} {1}.
Substitui um teste anterior: {0}|Supersedes an earlier test: {0}
 · {0} sem parecer| · {0} without a review
{0}/{1} pareceres prontos{2}|{0}/{1} reviews ready{2}
A enviar {0}|Sending {0}
{0} sem parecer|{0} without a review
{0} {1} do contexto principal|{0} {1} from the primary context
Paragem anterior: {0}|Previous stop: {0}
Ferramentas observadas: {0}|Observed tools: {0}
Ficheiros observados: {0}|Observed files: {0}
Caminhos: {0}|Paths: {0}
Todos ({0})|All ({0})
O {0} entra no lugar do {1}{2}. O {3} fica guardado como conversa do grupo.|{0} replaces {1}{2}. {3} is kept as a group conversation.
Contexto do {0} enviado com este pedido · {1}|Context from {0} sent with this request · {1}
{0} respostas independentes|{0} independent responses
Reenviar ao {0}|Resend to {0}
{0} entrou no lugar do {1}|{0} replaced {1}
Arquivada|Archived
ficheiro|file
ficheiros|files
contributo|contribution
contributos|contributions
parecer|review
pareceres|reviews
separado|separate
separados|separate
Parcial|Partial
Expandir|Expand
Recolher|Collapse
Progresso|Progress
Lista|List
Recolhido|Collapsed
falhou|failed
dispensado|skipped
parado|stopped
Separado|Separate
Selecionar|Select
Consultar|Consult
Pareceres|Reviews
Enviado|Sent
Parecer|Review
Aplicar|Apply
Implementar|Implement
Investigar|Investigate
Testar|Test
nenhum|none
participante|participant
participantes|participants
C (opcional)|C (optional)
A preparar novo plano|Preparing a new plan
A pausar…|Pausing…
 · autorizados: | · authorised:\u0020
 (parece preso)| (appears stuck)
A escrever|Writing
A consultar|Consulting
A enviar ao principal|Sending to primary
A analisar o pedido|Analysing the request
A preparar a resposta inicial…|Preparing the initial response…
A preparar resposta final|Preparing the final response
em curso|in progress
por fazer|not started
parecer separado|separate review
pareceres separados|separate reviews
À espera|Waiting
A preparar o revisor…|Preparing the reviewer…
A analisar a resposta inicial…|Analysing the initial response…
O que verificar|What to check
 parecer(es) enviado(s) ao principal| review(s) sent to primary
 prontos| ready
 · Em curso| · In progress
 · Com falhas| · With failures
Foco: |Focus:\u0020
A aguardar texto do revisor…|Waiting for reviewer text…
 · Custo: | · Cost:\u0020
＋ Outro participante|＋ Another participant
Ex.: procura falhas no plano, sugere alternativas ou avalia o design.|E.g. look for flaws in the plan, suggest alternatives or assess the design.
Revisores: |Reviewers:\u0020
escrita ativada|writing enabled
nesta conversa|in this conversation
envia apenas os pareceres que os revisores recomendarem|send only reviews recommended by reviewers
pareceres separados, envio manual|separate reviews, manual delivery
A carregar pareceres…|Loading reviews…
＋ Outro revisor|＋ Another reviewer
Ex.: avalia estes pareceres e melhora o plano.|E.g. assess these reviews and improve the plan.
A conversa mudou. Fecha e escolhe novamente.|The conversation changed. Close and choose again.
 · Projeto/pasta ou recurso reservado.| · Project/folder or resource reserved.
O Grok|Grok
O revisor Claude|The Claude reviewer
O principal|The primary
A escrever…|Writing…
pedido interrompido|request interrupted
Último pedido|Latest request
 · Contadores parciais| · Partial counters
 · Parcial| · Partial
 e fica como principal: implementa quando escolheres escrita| and becomes the primary: implements when you choose writing
＋ Adicionar participante|＋ Add participant
A preparar a resposta…|Preparing the response…
Pergunta de {0}: {1}|Question from {0}: {1}
Resposta: {0}|Answer: {0}
Resposta ({0}): {1}|Answer ({0}): {1}
{0} · configuração {1}|{0} · configuration {1}
 Ajusta as proteções {0}, se necessário, e retoma quando quiseres.| Adjust the safeguards {0}, if needed, and resume when you wish.
no painel Modo|in the Mode panel
acima|above
{0} turnos no total · proteção {1}|{0} total turns · safeguard {1}
 por retoma| per resume
desativada|disabled
Se um participante está preso ou sem acesso, podes retirá-lo e retomar com os outros dois, que passam a ter de estar de acordo. Os votos e revisões dele nesta versão deixam de contar. {0} é o principal e não pode sair.|If a participant is stuck or lacks access, you can remove it and resume with the other two, who must then agree. Its votes and reviews on this version stop counting. {0} is the primary and cannot leave.
Retirar {0} desta tarefa? Não volta a participar nela, e a conversa dele regressa ao modo normal.|Remove {0} from this task? It will not participate again, and its conversation returns to normal mode.
Em resposta a #{0}|In reply to #{0}
Versão {0} · {1}{2}{3}|Version {0} · {1}{2}{3}
{0}, revisão anterior ao esclarecimento: {1} — {2}|{0}, review before the clarification: {1} — {2}
{0} · {1} · código {2}{3}|{0} · {1} · exit code {2}{3}
Guião visual · rAF {0} Hz · p95 {1} ms · {2} intervalos acima de 50 ms. Medição sem capturas, numa execução separada.|Visual scenario · rAF {0} Hz · p95 {1} ms · {2} intervals over 50 ms. Measured without screenshots in a separate run.
{0} captura(s) da versão testada · gerar imagens não significa avaliação visual.|{0} screenshot(s) of the tested version · generating images does not constitute visual assessment.
Enviar {0} {1} à conversa|Send {0} {1} to the conversation
Entrada {0} · Saída {1}{2}|Input {0} · Output {1}{2}
Entrada: {0} · Saída: {1}{2}|Input: {0} · Output: {1}{2}
Os {0} resultados selecionados serão enviados ao {1}, mantendo as escolhas da conversa. O modelo avaliará as sugestões; não há implementação automática.|The {0} selected results will be sent to {1}, keeping the conversation's choices. The model will assess the suggestions; implementation is not automatic.
{0} aguarda a tua decisão. A tarefa só continua depois de responderes; não há corte automático por tempo.|{0} is waiting for your decision. The task continues only after you respond; there is no automatic time cutoff.
{0}Os ficheiros já criados ficam conservados. Podes preparar um novo pedido para o principal verificar o estado atual e continuar o que falta.|{0}Files already created are preserved. You can prepare a new request for the primary to check the current state and continue the remaining work.
Claude: {0} tokens de entrada · {1} de saída.|Claude: {0} input tokens · {1} output tokens.
{0} eventos anteriores não mostrados nesta vista; originais conservados nos históricos locais.|{0} earlier events are not shown in this view; originals are preserved in local histories.
Ações observadas: {0} ficheiro{1} · {2} comando{3}.|Observed actions: {0} file{1} · {2} command{3}.
{0} · decisão pendente|{0} · decision pending
Principal · {0}/{1} turnos medidos · Entrada {2} · Cache {3} · Saída {4}{5}|Primary · {0}/{1} turns measured · Input {2} · Cache {3} · Output {4}{5}
Principal · {0} turnos · Contadores ainda indisponíveis|Primary · {0} turns · Counters not yet available
{0}/{1} revisões medidas · Entrada {2} · Cache {3} · Saída {4}|{0}/{1} reviews measured · Input {2} · Cache {3} · Output {4}
 · Subtotal medido: entrada {0} · cache {1} · saída {2}{3}| · Measured subtotal: input {0} · cache {1} · output {2}{3}
Total {0} · Histórico anterior à medição de espera|Total {0} · History from before waiting time was measured
Trabalho e preparação {0} · Espera por decisões {1}{2}|Work and preparation {0} · Waiting for decisions {1}{2}
Enviar a{0} ↗|Send to {0} ↗
Enviar a {0} de {1} · {2} ↗|Send to {0} of {1} · {2} ↗
Enviar ao principal · {0} ↗|Send to primary · {0} ↗
A implementação vai só para o principal: {0}. O outro recebe o resultado quando voltares a falar com ele.|Implementation goes only to the primary: {0}. The other participant receives the result when you next speak to it.
{0} · desligado neste Multi. Clica para ligar ao Multi.|{0} · disabled in this Multi. Click to join Multi.
{0}{1}{2}. Ligado no Multi: clica para desligar.|{0}{1}{2}. Enabled in Multi: click to disable.
 · principal| · primary
Liga primeiro o {0} para o pôr no Multi.|Connect {0} first to add it to Multi.
Não há um modelo disponível no catálogo de {0}.|No model is available in the {0} catalogue.
O {0} já participa neste Multi. Para falar só com ele, escolhe-o no seletor.|{0} is already in this Multi. To speak only to it, choose it in the selector.
{0} entrou no lugar do {1}. Recebe o histórico da conversa no primeiro pedido.|{0} replaced {1}. It receives the conversation history with its first request.
Envia a mesma pergunta só ao {0}, sem a resposta do outro a esta ronda. O que já foi entregue não se repete.|Send the same question only to {0}, without the other's response to this round. Previously delivered content is not repeated.
Parar só o {0}. Os restantes continuam.|Stop only {0}. The others continue.
Síntese parcial · com {0} de {1} respostas…|Partial synthesis · with {0} of {1} responses…
Faltam respostas de {0}. A síntese parcial identifica as ausências.|Responses from {0} are missing. The partial synthesis identifies the absences.
Parcial: faltam respostas de {0}.|Partial: responses from {0} are missing.
Contexto entregue a {0} sessões; segue uma vez para cada participante que ainda não recebeu.|Context delivered to {0} sessions; sent once to each participant that has not yet received it.
A sintetizar|Synthesising
Parada|Stopped
sem registo|not recorded
completo|complete
em excerto|excerpted
resumido|summarised
sem nada novo|nothing new
A enviar|Sending
A responder|Responding
A preparar|Preparing
Avaliação pendente · limite atingido|Assessment pending · limit reached
Pronta|Ready
Principal a trabalhar|Primary working
Executor em fila|Executor queued
Grok a trabalhar|Grok working
Claude a rever|Claude reviewing
Principal a avaliar|Primary assessing
A parar|Stopping
Colaborações guardadas|Saved collaborations
＋ Nova colaboração|＋ New collaboration
Conversa da equipa|Team conversation
Verificar limpeza e desbloquear|Check cleanup and unlock
Equipa e pasta|Team and folder
Principal · Codex|Primary · Codex
Raciocínio do principal|Primary reasoning
Executor · Grok 4.7 · raciocínio|Executor · Grok 4.7 · reasoning
Contexto do executor|Executor context
Fast do executor|Executor Fast mode
Ligado · maior consumo|On · higher usage
Revisão independente|Independent review
Sem revisor|No reviewer
Claude · só leitura|Claude · read only
Modelo do revisor|Reviewer model
Raciocínio do revisor|Reviewer reasoning
O principal decide e avalia, com acesso só de leitura. O Grok pode alterar ficheiros e executar comandos; as autorizações nativas aparecem aqui. O isolamento pelo sistema operativo não está comprovado. O revisor Claude opcional só lê código, sem terminal nem edição; consome a subscrição Claude. Sem corte por tempo. Parar interrompe a tarefa; até três delegações por pedido. As escolhas aplicam-se ao próximo pedido.|The primary decides and assesses with read-only access. Grok can change files and run commands; native approvals appear here. Operating system isolation has not been verified. The optional Claude reviewer only reads code, without terminal access or editing, and uses the Claude subscription. No time cutoff. Stop interrupts the task; up to three delegations per request. Choices apply to the next request.
Ver e responder|View and respond
Mensagens da equipa|Team messages
Consumo e tempo do pedido|Request usage and timing
Decisões pendentes da colaboração|Pending collaboration decisions
Preparar continuação|Prepare continuation
Pedido para o principal|Request for the primary
Descreve o objetivo. O principal decide o que delegar…|Describe the goal. The primary decides what to delegate…
Trabalho delegado|Delegated work
A abrir colaboração…|Opening collaboration…
Outra pasta…|Another folder…
O contexto é partilhado apenas com este projeto. Outros projetos independentes podem trabalhar em paralelo; o mesmo cliente normal executa um pedido de cada vez.|Context is shared only with this project. Other independent projects can work in parallel; the same normal client runs one request at a time.
Sem projeto associado: esta colaboração não partilha memória nem aparece na atividade de projetos.|No linked project: this collaboration does not share memory or appear in project activity.
Define o objetivo com o principal. Ele pode planear, delegar trabalho no Grok e avaliar o resultado nesta mesma conversa.|Define the goal with the primary. It can plan, delegate work to Grok and assess the result in this conversation.
Executor e revisão|Executor and review
As mensagens e os relatórios aparecem no chat. Aqui encontras comandos, ficheiros e detalhes das tarefas.|Messages and reports appear in the chat. Commands, files and task details appear here.
Contexto partilhado apenas com este projeto.|Context shared only with this project.
Responde à decisão pendente acima. A espera não cancela a tarefa.|Respond to the pending decision above. Waiting does not cancel the task.
Podes preparar o próximo pedido. Parar interrompe o ciclo.|You can prepare the next request. Stop interrupts the cycle.
Este pedido parou pelo limite antigo. Os pedidos novos já não têm corte por tempo. |This request stopped at the former limit. New requests no longer have a time cutoff.\u0020
Detalhes do trabalho|Work details
O executor não comunica contadores de consumo. A poupança de quota depende da tarefa.|The executor does not report usage counters. Quota savings depend on the task.
O principal ainda não delegou nenhuma tarefa.|The primary has not delegated any tasks yet.
Revisão independente só de leitura. O revisor não executa testes.|Independent read-only review. The reviewer does not run tests.
Ver revisão no chat|View review in chat
Ver tarefa no chat|View task in chat
A tarefa foi interrompida enquanto aguardava uma decisão. Nenhuma autorização foi concedida automaticamente.|The task was interrupted while waiting for a decision. No approval was granted automatically.
Revi os ficheiros e resultados parciais. Quero permitir um novo pedido, sem repetir tarefas automaticamente.|I reviewed the files and partial results. I want to allow a new request without automatically repeating tasks.
Confirmar revisão do estado|Confirm status review
Executor · Cursor|Executor · Cursor
Revisor · Claude|Reviewer · Claude
Investigação|Research
Tarefa delegada|Delegated task
Só leitura. O revisor não executa testes.|Read only. The reviewer does not run tests.
Instruções da tarefa|Task instructions
Ver ações e ficheiros|View actions and files
Mensagem abreviada nesta vista; original conservado no histórico nativo.|Message shortened in this view; original preserved in native history.
Contexto do projeto enviado com este pedido|Project context sent with this request
Revisor Claude|Claude reviewer
O trabalho está em pausa até responderes. Permitir ou recusar aplica-se apenas às opções anunciadas pelo cliente.|Work is paused until you respond. Allowing or rejecting applies only to the options announced by the client.
Ferramenta do Cursor|Cursor tool
Recusar sempre|Always reject
Permitir leitura|Allow reading
Confirma o pedido.|Confirm the request.
O teu rascunho foi conservado. Envia-o ou limpa-o antes de preparar a continuação.|Your draft was preserved. Send or clear it before preparing the continuation.
Pedido anterior|Previous request
não participou|did not participate
 · Grok: não medido| · Grok: not measured
 · Grok: não participou| · Grok: did not participate
 · Medição parcial após interrupção| · Partial measurement after interruption
Na fila|Queued
parcial: respostas do terminal não importadas|partial: terminal responses not imported
Não enviado|Not sent
Plano recebido|Plan received
Multi: dois a quatro clientes respondem de forma independente na mesma ronda. O histórico passa entre rondas; só o principal implementa.|Multi: two to four clients respond independently in the same round. History is shared between rounds; only the primary implements.
A revisão automática segue os pedidos individuais ao principal.|Automatic review follows individual requests to the primary.
Seleciona pelo menos um destinatário.|Select at least one recipient.
Selecionar vários|Select multiple
Selecionar vários destinatários: cada botão junta ou retira um participante|Select multiple recipients: each button adds or removes a participant
Destinatário: todos ou um participante|Recipient: everyone or one participant
Principal · implementa e decide|Primary · implements and decides
Participantes do Multi (clica num cliente para o ligar ou desligar)|Multi participants (click a client to turn it on or off)
Este cliente é a sessão inicial da conversa. Liga outro participante ou desliga o Multi.|This client is the conversation's initial session. Enable another participant or disable Multi.
Aguarda que as respostas terminem para mudar os participantes do Multi.|Wait for responses to finish before changing Multi participants.
A conversa está no terminal. Usa «Continuar na HYDRAQ» antes de mudar os participantes do Multi.|The conversation is in the terminal. Use “Continue in HYDRAQ” before changing Multi participants.
Mantém pelo menos um cliente ligado no Multi, ou desliga o Multi.|Keep at least one client enabled in Multi, or disable Multi.
O Multi permite até quatro participantes. Desliga primeiro outro cliente.|Multi allows up to four participants. Disable another client first.
O Multi mudou entretanto. Revê os participantes.|Multi changed in the meantime. Review the participants.
Muda o modelo e o raciocínio deste participante, ou põe outro cliente no seu lugar. O Multi continua ligado e nada é enviado. As respostas anteriores mantêm quem as deu; um cliente novo recebe o histórico da conversa no primeiro pedido.|Change this participant's model and reasoning, or replace it with another client. Multi stays enabled and nothing is sent. Earlier responses keep their authorship; a new client receives the conversation history with its first request.
Aguarda que as respostas terminem para mudar de cliente.|Wait for responses to finish before changing clients.
A conversa está no terminal. Usa «Continuar na HYDRAQ» antes de mudar de cliente ou de principal.|The conversation is in the terminal. Use “Continue in HYDRAQ” before changing the client or primary.
Multi · adicionar participante|Multi · add participant
Adicionar participante|Add participant
Multi · dois a quatro participantes|Multi · two to four participants
Cada cliente responde de forma independente na mesma ronda. Entre rondas, recebe o histórico dos restantes, com excertos assinalados quando necessário. Só o principal implementa.|Each client responds independently in the same round. Between rounds, it receives the others' history, with labelled excerpts when needed. Only the primary implements.
Desligar Multi|Disable Multi
Há um lugar desligado. Liga um segundo cliente pela barra ou desliga o Multi.|A slot is disabled. Enable a second client in the bar or disable Multi.
Para remover o principal, seleciona primeiro a estrela de outro participante.|To remove the primary, first select another participant's star.
Liga primeiro outro cliente para ativar o Multi.|Connect another client first to enable Multi.
Ativar Multi|Enable Multi
Usar no primeiro pedido|Use for the first request
Remover Multi|Remove Multi
Contexto da passagem|Handoff context
Sem resposta visível.|No visible response.
Resposta de |Response from\u0020
Parar todos|Stop all
Parar todos os modelos. O que já responderam fica guardado.|Stop all models. Their existing responses are saved.
Outra síntese…|Another synthesis…
Aguarda a síntese em curso ou para-a.|Wait for the current synthesis or stop it.
Um modelo à tua escolha escreve uma resposta final a partir das respostas, numa sessão à parte.|A model of your choice writes a final response from the responses in a separate session.
A síntese automática desta ronda não ficou confirmada e não foi repetida. Podes pedi-la aqui.|This round's automatic synthesis was not confirmed and was not repeated. You can request it here.
Síntese · |Synthesis ·\u0020
automática|automatic
Não entra no contexto dos participantes.|Does not enter the participants' context.
Parar a síntese. As respostas dos participantes não mudam.|Stop the synthesis. Participants' responses stay unchanged.
A preparar a síntese…|Preparing the synthesis…
Sem texto.|No text.
Síntese parcial|Partial synthesis
Sintetizar as respostas|Synthesise responses
Síntese do Multi|Multi synthesis
Um modelo escreve uma resposta final a partir das respostas, numa sessão à parte. As sessões do Multi não a veem, a não ser que a mandes para a próxima ronda.|A model writes a final response from the responses in a separate session. Multi sessions do not see it unless you send it to the next round.
Quem sintetiza, e se a síntese corre sozinha no fim de cada ronda enviada a vários.|Who synthesises, and whether synthesis runs automatically after each round sent to multiple participants.
 Faltam respostas nesta ronda: a síntese identifica todas as ausências.| Responses are missing from this round: the synthesis identifies all absences.
Quem sintetiza|Who synthesises
Outro modelo…|Another model…
Instruções opcionais|Optional instructions
Ex.: junta tudo sem descartar nada; foca a segurança.|E.g. combine everything without discarding anything; focus on security.
Entra no contexto da ronda seguinte|Include in the next round's context
Desligado: só tu vês a síntese. Ligado: na próxima ronda, cada participante recebe-a uma vez, como contexto citado.|Off: only you see the synthesis. On: each participant receives it once in the next round as quoted context.
Fazer automaticamente no fim de cada ronda a vários|Run automatically after each round with multiple participants
Corre sozinha quando todas as respostas terminam, com estas escolhas. Não corre se faltar uma resposta.|Runs automatically with these choices when all responses finish. Does not run if a response is missing.
Diagnóstico do cliente|Client diagnostics
Detalhes comunicados pelo cliente|Details reported by the client
Resultado incerto|Uncertain result
Sem raciocínio|No reasoning
Mínimo|Minimal
Muito alto|Very high
Comentar resposta|Comment on the response
Criticar plano|Critique the plan
Rever implementação|Review implementation
Resposta inicial em curso|Initial response in progress
Resposta inicial pronta · a consultar revisores|Initial response ready · consulting reviewers
Revisores a analisar|Reviewers analysing
Pareceres prontos · a enviar ao principal|Reviews ready · sending to primary
Principal a preparar resposta final|Primary preparing the final response
Revisão concluída|Review completed
Revisão dispensada|Review skipped
Revisão falhou|Review failed
Revisão suspensa|Review suspended
Revisão parada|Review stopped
Decisão de envio pendente|Delivery decision pending
Resposta inicial a ser escrita|Writing the initial response
Consulta concluída|Consultation completed
Resposta inicial|Initial response
Envio ao principal|Delivery to primary
Resposta final|Final response
Nenhum recomendado|None recommended
Mantida a inicial|Initial response kept
Suspensa · nada reenviado|Suspended · nothing resent
Sem confirmação|Unconfirmed
Envio falhou|Delivery failed
Não iniciada|Not started
Separado · decisão de envio pendente|Separate · delivery decision pending
Separado · revisor recomenda enviar|Separate · reviewer recommends delivery
Separado · revisor não recomendou enviar|Separate · reviewer did not recommend delivery
Enviado ao principal|Sent to primary
Entrega incerta · não reenviado|Uncertain delivery · not resent
Envio falhou · separado do contexto principal|Delivery failed · separate from primary context
Separado · ainda não enviado ao principal|Separate · not yet sent to primary
Mais recente|Latest
Voltar a acompanhar o texto mais recente|Follow the latest text again
Copiar o texto deste painel|Copy text from this panel
Não foi possível copiar o texto.|Could not copy the text.
Copiar texto · |Copy text ·\u0020
Repor tamanho · |Reset size ·\u0020
Expandir · |Expand ·\u0020
Repor o tamanho fixo|Reset fixed size
Expandir este painel em largura total|Expand this panel to full width
Consultar outros modelos|Consult other models
Escolha rápida de modelos|Quick model selection
Mostrar esta mensagem completa|Show this entire message
Recolher o texto desta mensagem|Collapse this message's text
Parar revisão|Stop review
Parar a revisão automática. A resposta inicial e os pareceres já recebidos ficam guardados.|Stop automatic review. The initial response and reviews already received are saved.
Etapas da revisão|Review stages
Sem resposta inicial visível.|No visible initial response.
Resposta inicial de |Initial response from\u0020
Etapas da avaliação do principal|Primary assessment stages
Resposta da avaliação · parcial|Assessment response · partial
· após os pareceres recebidos|· after the reviews received
Parecer recebido deste cliente; a resposta indica quais as sugestões aceites.|Review received from this client; the response identifies which suggestions were accepted.
Apresentação da revisão|Review display
Painéis|Panels
Chat|Chat
Etapas|Stages
Resposta inicial e revisores lado a lado, em painéis de tamanho fixo|Initial response and reviewers side by side in fixed-size panels
Mensagens completas, umas por baixo das outras|Full messages, one below another
Mostrar só as etapas; a resposta final continua visível|Show stages only; the final response stays visible
concluído|completed
requer atenção|needs attention
Enviar selecionados à conversa|Send selected reviews to conversation
Enviar ao principal os pareceres selecionados que ficaram separados, com um comentário opcional.|Send the selected separate reviews to the primary, with an optional comment.
Começa quando a resposta inicial estiver pronta.|Starts when the initial response is ready.
Revisor |Reviewer\u0020
Escrita explicitamente ativada · autorizações nativas|Writing explicitly enabled · native approvals
Planear / só leitura · não edita ficheiros|Plan / read only · does not edit files
Escrita ativada|Writing enabled
Decisão pendente: |Decision pending:\u0020
Recomenda enviar: |Recommends delivery:\u0020
Não recomenda enviar: |Does not recommend delivery:\u0020
O revisor aguarda a tua decisão.|The reviewer is waiting for your decision.
Sem texto comunicado pelo revisor.|No text reported by the reviewer.
Parecer de |Review from\u0020
Entrega incerta|Uncertain delivery
Não recomenda enviar|Does not recommend delivery
custo não medido|cost not measured
Selecionar parecer de |Select review from\u0020
Enviar este|Send this review
Outra resposta|Another response
Segunda opinião|Second opinion
 · indisponível| · unavailable
Responde à mesma pergunta noutra sessão.|Answer the same question in another session.
Avalia esta resposta noutra sessão.|Assess this response in another session.
Fechar escolha rápida|Close quick selection
Instruções adicionais / foco|Additional instructions / focus
Ex.: propõe uma alternativa mais simples.|E.g. propose a simpler alternative.
Ex.: procura regressões e casos limite.|E.g. look for regressions and edge cases.
Mais opções…|More options…
Comparar vários modelos, indicar um foco e consultar os detalhes do contexto.|Compare several models, specify a focus and view context details.
Consultar agora (Ctrl+Enter). As escolhas desta conversa mantêm-se.|Consult now (Ctrl+Enter). This conversation's choices are kept.
Contexto interno · |Internal context ·\u0020
Pedido interno de síntese. Os pareceres são contexto citado; só o principal decide o que aceitar.|Internal synthesis request. Reviews are quoted context; only the primary decides what to accept.
Instruções da avaliação|Assessment instructions
Conteúdo enviado · histórico arquivado|Content sent · archived history
Revisão automática · |Automatic review ·\u0020
Parar revisão automática|Stop automatic review
Investigação delegada|Delegated research
Outras respostas|Other responses
 · Decisão pendente| · Decision pending
Resposta independente|Independent response
 · não entra automaticamente no contexto da conversa.| · does not automatically enter the conversation context.
Filtrar pareceres por entrega|Filter reviews by delivery
Por enviar|Not sent
 · ciclo automático em curso| · automatic cycle in progress
À espera de autorização|Waiting for approval
Ainda a preparar o cliente|Still preparing the client
Atividade recente do cliente|Recent client activity
Sem atividade recente reportada pelo cliente|No recent activity reported by the client
Verificado às |Checked at\u0020
Raciocínio e atividade comunicados pelo cliente|Reasoning and activity reported by the client
não medida|not measured
Parar delegação|Stop delegation
Parar este parecer|Stop this review
Enviar ao principal|Send to primary
Enviar este à conversa|Send this to the conversation
 · decisão pendente| · decision pending
Permitir sempre pode guardar a autorização na configuração do Cursor para pedidos futuros.|Always allow may save approval in Cursor's settings for future requests.
Aceitar plano|Accept plan
Permitir desta vez|Allow this time
O ciclo automático ainda está em curso.|The automatic cycle is still running.
Aguarda os restantes pareceres ou interrompe-os antes de enviar à conversa.|Wait for the remaining reviews or interrupt them before sending to the conversation.
Enviar apenas os resultados selecionados que ainda estão separados, com um comentário opcional.|Send only the selected results that are still separate, with an optional comment.
Os participantes recebem a pergunta e o contexto anterior relevante, sem as respostas posteriores.|Participants receive the question and relevant earlier context, without subsequent responses.
Os participantes recebem a pergunta, esta resposta e o contexto relevante, incluindo referências aos ficheiros observados.|Participants receive the question, this response and relevant context, including references to observed files.
Foco opcional|Optional focus
Contexto e limites|Context and limits
Sem troca de cliente na conversa principal. Cada participante usa uma sessão própria, com as ferramentas habituais em Planear (só leitura no Codex), e consome a sua conta/quota. As autorizações aparecem no respetivo cartão. Históricos extensos seguem como excertos identificados.|No client switch in the main conversation. Each participant uses its own session and usual tools in Plan mode (read only in Codex), consuming its own account quota. Approvals appear on the corresponding card. Long histories are sent as labelled excerpts.
Consultar modelos|Consult models
Escolhe pelo menos um participante.|Choose at least one participant.
Revisor · |Reviewer ·\u0020
Código|Code
Planear / só leitura|Plan / read only
só no próximo pedido|only for the next request
pareceres reunidos numa avaliação pelo principal|reviews combined into one assessment by the primary
Revisor desligado. Escolher até quatro revisores para o próximo pedido ou esta conversa.|Reviewer off. Choose up to four reviewers for the next request or this conversation.
O pedido ainda não foi enviado.|The request has not been sent yet.
Enviar sem revisão|Send without review
A conversa mudou. Revê o pedido antes de enviar.|The conversation changed. Review the request before sending.
Configurar revisor|Configure reviewer
Tentar carregar pareceres|Try loading reviews
Não foi possível ler os pareceres anteriores: |Could not read previous reviews:\u0020
Carregar pareceres anteriores|Load previous reviews
Histórico preservado · carregado por páginas|History preserved · loaded in pages
Revisores automáticos|Automatic reviewers
Cada modelo revê a resposta ou o código. Por omissão, só o principal pode implementar: os revisores apontam problemas e melhorias em Planear/Só leitura. Podes enviar sempre, deixar cada revisor decidir se vale a pena enviar, ou escolher manualmente. Os pareceres enviados seguem juntos numa única avaliação pelo principal, mantendo as permissões do pedido original. Uma ronda, sem repetição.|Each model reviews the response or code. By default, only the primary can implement: reviewers identify problems and improvements in Plan/Read only mode. You can always send, let each reviewer decide whether delivery is worthwhile, or choose manually. Sent reviews are combined into one assessment by the primary, preserving the original request's permissions. One round, without repetition.
Quando rever|When to review
Todas as respostas finais|All final responses
Só ao planear / só leitura|Only in Plan / Read only mode
Só após alterações observadas|Only after observed changes
Duração|Duration
Manter nesta conversa|Keep for this conversation
Permitir editar ficheiros · |Allow file editing ·\u0020
Permitir editar ficheiros|Allow file editing
Desligado por omissão. Ativar dá ao revisor modo de execução com autorizações nativas; nunca ativa aceitação automática. Se algum revisor puder escrever, a equipa trabalha em sequência.|Off by default. Enabling gives the reviewer execution mode with native approvals; it never enables automatic acceptance. If any reviewer can write, the team works sequentially.
Remover revisor|Remove reviewer
Permitir editar ficheiros · Revisor |Allow file editing · Reviewer\u0020
Enviar pareceres ao principal|Send reviews to primary
Enviar sempre|Always send
Enviar apenas se necessário|Send only if necessary
Envio manual|Manual delivery
Se necessário: cada revisor decide com justificação. Só os recomendados seguem automaticamente. Os restantes ficam separados e podem ser enviados manualmente.|If necessary: each reviewer decides with a reason. Only recommended reviews are sent automatically. Others remain separate and can be sent manually.
Em «Enviar apenas se necessário», cada revisor indica se encontrou um erro, risco ou melhoria relevante que justifique nova avaliação. Só os pareceres recomendados seguem automaticamente. Os restantes continuam visíveis e enviáveis à mão. Decisões inválidas ou em falta ficam pendentes, sem aprovação implícita. Cada revisor usa a sua conta/quota. A revisão de código exige alterações de ficheiros observadas.|With “Send only if necessary”, each reviewer states whether it found an error, risk or relevant improvement warranting reassessment. Only recommended reviews are sent automatically. Others remain visible and can be sent manually. Invalid or missing decisions stay pending without implicit approval. Each reviewer uses its own account quota. Code review requires observed file changes.
A conversa mudou. Abre novamente as opções.|The conversation changed. Open the options again.
Escolhe pelo menos um revisor.|Choose at least one reviewer.
Abre a conversa de origem para incorporar estes pareceres.|Open the source conversation to incorporate these reviews.
Aguarda os outros pareceres ou interrompe-os antes de enviar.|Wait for the other reviews or interrupt them before sending.
Enviar à conversa|Send to conversation
Comentário opcional|Optional comment
Enviar ao |Send to\u0020
O envio anterior está |The previous delivery is\u0020
; não foi reenviado.|; it was not resent.
A preparar todos|Preparing all participants
A rever a resposta comum|Reviewing the shared response
A pausar todos|Pausing all participants
Em pausa|Paused
Progresso por confirmar|Unconfirmed progress
Parado|Stopped
Proteção atingida|Safeguard reached
Sem acordo|No agreement
Resposta comum · aprovada por todos|Shared response · approved by everyone
Acordo sobre as divergências|Agreement on disagreements
Posições atribuídas · sem acordo|Attributed positions · no agreement
Síntese do autor · sem acordo obrigatório|Author's synthesis · agreement not required
Proposta de acordo|Agreement proposal
Descrição das divergências|Description of disagreements
Fase|Phase
Posição inicial|Initial position
Pergunta|Question
Resposta|Answer
Descoberta|Finding
Objeção|Objection
Resposta à objeção|Response to objection
Resolução|Resolution
Impasse declarado|Declared deadlock
Descrição recusada|Description rejected
Novo requisito|New requirement
Contexto recuperado|Recovered context
Replaneamento|Replanning
Plano em discussão|Discussing the plan
Implementação por etapas|Implementation in stages
Correções em curso|Fixes in progress
Revisão e testes de todos|Review and tests by everyone
Conclusão em revisão|Conclusion under review
A testar|Testing
Passou|Passed
Tempo esgotado|Timed out
Problema do ambiente|Environment issue
Aprovado|Approved
Pede correções|Requests changes
Bloqueado|Blocked
Discorda|Disagrees
Resposta recebida|Response received
Erro ao preparar ou executar|Preparation or execution error
Efeitos por confirmar|Effects not confirmed
Interrompida antes de enviar|Interrupted before sending
A executar|Running
A iniciar|Starting
A trabalhar|Working
Aguarda decisão|Waiting for a decision
Turno terminado|Turn finished
Por confirmar|Unconfirmed
modelo|model
sem texto|no text
sem resposta|no answer
Sem resposta.|No answer.
＋ Nova tarefa Hydra|＋ New Hydra task
Tarefas Hydra|Hydra tasks
Dois ou três modelos discutem o plano. Quando pedes alterações, os implementadores autorizados executam por etapas; todos reveem e testam. Perguntas e pedidos de planeamento ficam em leitura. Escolhe os participantes no painel Modo e escreve um único pedido.|Two or three models discuss the plan. When you request changes, authorised implementers work in stages; everyone reviews and tests. Questions and planning requests remain read only. Choose participants in the Mode panel and write a single request.
Participantes · contexto e proteções|Participants · context and safeguards
Participante |Participant\u0020
Sem terceiro participante|No third participant
 · modelo| · model
Raciocínio · |Reasoning ·\u0020
Principal · coordena o plano e a conclusão|Primary · coordinates the plan and conclusion
Implementadores autorizados|Authorised implementers
Preferências de distribuição|Work allocation preferences
Ex.: Claude na interface, Codex na lógica; o restante fica ao acordo do grupo.|E.g. Claude on the interface, Codex on logic; let the group agree on the rest.
Ferramentas externas (MCP)|External tools (MCP)
Desligadas|Off
Escolher servidores para esta tarefa|Choose servers for this task
Servidores MCP externos|External MCP servers
Quem usa ferramentas externas|Who uses external tools
Só o principal|Primary only
Todos os participantes|All participants
Autorização de ações externas|External action authorisation
Risco ainda não aceite|Risk not yet accepted
Aceito ações autónomas fora do isolamento, sem aprovação por chamada|I accept autonomous actions outside isolation, without per-call approval
Os servidores escolhidos executam com as permissões do utilizador, fora do isolamento. Uma ação já iniciada pode continuar após uma pausa. Só os ficheiros exportados para a pasta de trabalho são revistos nos testes. Esta autorização não passa para tarefas novas.|The selected servers run with the user's permissions, outside isolation. An action already started may continue after a pause. Only files exported to the working folder are reviewed in tests. This authorisation does not carry over to new tasks.
Maioria · 2/2 ou 2/3|Majority · 2/2 or 2/3
Tipo de pedido|Request type
Seguir o pedido · implementar só se pedido|Follow the request · implement only when requested
Só análise e planeamento|Analysis and planning only
Local de trabalho|Work location
Cópia privada|Private copy
Proteção · turnos por participante|Safeguard · turns per participant
Proteção · minutos ativos|Safeguard · active minutes
Plano e distribuição → implementação por etapas → revisão e testes por todos → conclusão. Com três modelos, dois votos bastam; testes falhados impedem concluir. Testes dos revisores correm em cópias isoladas, sem rede.|Plan and allocation → implementation in stages → review and tests by everyone → conclusion. With three models, two votes are enough; failing tests prevent completion. Reviewer tests run in isolated copies without network access.
As proteções pausam a tarefa e preservam o progresso. 0 desativa a proteção respetiva. Cada retoma abre uma nova contagem de turnos e minutos. Podes ajustá-las antes de iniciar ou durante uma pausa.|Safeguards pause the task and preserve progress. 0 disables the corresponding safeguard. Each resume starts a new turn and minute count. You can adjust them before starting or while paused.
Estado dos participantes|Participant status
Diálogo|Dialogue
Resposta comum do Hydra|Hydra's shared response
Versões e aprovações|Versions and approvals
Pedido para o Hydra|Request for Hydra
O que queres que os participantes investiguem juntos?|What would you like the participants to investigate together?
Iniciar ClaudeX|Start ClaudeX
Pausar todos|Pause all
Terminar tarefa|End task
Liberta as conversas; o progresso fica guardado.|Release conversations; progress is saved.
Nova tarefa com este progresso|New task with this progress
Abre novas sessões com o progresso identificado; conserva a tarefa anterior.|Open new sessions with the progress identified; keep the previous task.
Só análise e planeamento: não cria cópia nem altera o projeto.|Analysis and planning only: does not create a copy or change the project.
Os modelos trabalham numa cópia privada. O resultado só chega ao projeto depois dos testes e da aprovação final.|Models work in a private copy. The result reaches the project only after tests and final approval.
Os modelos trabalham no projeto. As alterações são feitas durante a implementação.|Models work in the project. Changes are made during implementation.
 A cópia privada requer o servidor atualizado.| The private copy requires an updated server.
Os servidores escolhidos executam com as permissões do utilizador, fora do isolamento. Sem aprovação por chamada; ações já iniciadas podem continuar após uma pausa. Só os ficheiros exportados para a pasta de trabalho são revistos nos testes. A autorização não passa para tarefas novas.|The selected servers run with the user's permissions, outside isolation. There is no per-call approval; actions already started may continue after a pause. Only files exported to the working folder are reviewed in tests. Authorisation does not carry over to new tasks.
Interrupção por confirmar|Interruption not confirmed
Principal a responder à objeção|Primary responding to the objection
Plano, execução e revisão|Plan, execution and review
Voltar a tentar parar|Try stopping again
Parar e desfazer aplicação|Stop and undo application
Confirmar alterações e retomar|Confirm changes and resume
Retomar a mesma tarefa|Resume the same task
Atualizar o pedido de todos|Update everyone's request
Nova tarefa a partir deste progresso|New task from this progress
Iniciar |Start\u0020
Novo requisito opcional para todos; retoma também com a caixa vazia.|Optional new requirement for everyone; leave empty to resume without one.
Pedido para uma nova tarefa com este progresso.|Request for a new task with this progress.
Ativa em Configurações → Clientes: |Enable in Settings → Clients:\u0020
Liga |Connect\u0020
 e | and\u0020
 nas Conversas.| in Conversations.
A preservar o progresso e a interromper os clientes.|Preserving progress and interrupting clients.
Novos requisitos chegam a todos e anulam aprovações anteriores.|New requirements reach everyone and invalidate previous approvals.
Retoma o mesmo histórico e as mesmas sessões nativas. Um requisito novo é opcional.|Resume the same history and native sessions. A new requirement is optional.
Nova tarefa na mesma conversa e com as mesmas sessões, com o progresso anterior identificado.|New task in the same conversation and sessions, with previous progress identified.
Uma tarefa · 2–3 participantes · uma resposta comum|One task · 2–3 participants · one shared response
A aplicar o resultado aprovado ao projeto. Aguarda o fim desta operação.|Applying the approved result to the project. Wait for this operation to finish.
A aplicar ao projeto…|Applying to the project…
Para a tarefa e devolve a conversa ao modo anterior; o progresso fica guardado.|Stop the task and return the conversation to its previous mode; progress is saved.
Arquivada: o agy desta tarefa trabalhava no ambiente privado antigo do Hydra, que foi retirado, e a sua sessão não pode ser retomada. Podes continuar o conteúdo numa tarefa nova, com sessões novas e o progresso identificado.|Archived: this task's agy used Hydra's former private environment, which has been retired, so its session cannot resume. You can continue the content in a new task with new sessions and the progress identified.
Progresso preservado. A retoma é explícita.|Progress preserved. Resuming requires an explicit action.
 A retoma pode ser recusada se a entrega nativa for incerta. Podes abrir uma nova tarefa com este progresso e novas sessões.| Resuming may be refused if native delivery is uncertain. You can open a new task with this progress and new sessions.
Reinicia o servidor HYDRAQ para ativar esta versão do Hydra. O histórico continua disponível.|Restart the HYDRAQ server to enable this version of Hydra. History remains available.
Pedido comum|Shared request
Copiar pedido|Copy request
hora não registada|time not recorded
Ainda não leu o diálogo|Has not read the dialogue yet
Resumo do raciocínio · Claude|Reasoning summary · Claude
 (substituído)| (superseded)
Aprovou a versão atual|Approved the current version
Última contribuição|Latest contribution
Responder à decisão de |Respond to the decision from\u0020
Copiar resposta|Copy response
A versão candidata está em revisão. O documento final aparece aqui quando o processo terminar.|The candidate version is under review. The final document appears here when the process finishes.
Consumo de quota da tarefa|Task quota usage
Ponto de segurança Git · |Git checkpoint ·\u0020
Ver alterações desde o ponto de segurança|View changes since the checkpoint
Etapas de implementação|Implementation stages
 · em execução| · running
Escrita sequencial em pastas independentes; correções: |Sequential writes in independent folders; fixes:\u0020
Ferramentas externas · fora do isolamento|External tools · outside isolation
Ações externas não foram certificadas pelos testes isolados. Uma ação já iniciada pode continuar após uma pausa.|External actions were not certified by isolated tests. An action already started may continue after a pause.
Retirar participante|Remove participant
Continuar sem um participante|Continue without a participant
Local de trabalho do Hydra|Hydra work location
Trabalho na cópia privada|Working in the private copy
No projeto|In the project
Este pedido não altera o projeto.|This request does not change the project.
O projeto recebe o resultado depois dos testes e da aprovação final.|The project receives the result after tests and final approval.
As alterações são feitas no projeto durante a implementação.|Changes are made in the project during implementation.
Projeto libertado sem desfazer|Project released without undoing changes
A pasta privada desapareceu com a aplicação a meio. O projeto pode ter parte da versão aplicada; verifica-o antes de continuar.|The private folder disappeared while changes were being applied. Part of the version may have reached the project; check it before continuing.
Aplicação por concluir|Application incomplete
O projeto pode estar parcialmente alterado, e a pasta privada desapareceu, por isso não dá para desfazer. Se foi movida ou está num disco desligado, repõe-na e tenta outra vez.|The project may be partially changed, and the private folder has disappeared, so changes cannot be undone. If it was moved or is on a disconnected drive, restore it and try again.
O projeto pode estar parcialmente alterado. A recuperação fica guardada até a aplicação terminar ou ser desfeita.|The project may be partially changed. Recovery data is kept until application finishes or is undone.
A aplicar ao projeto|Applying to the project
Aplicado ao projeto|Applied to the project
 Há alterações externas indicadas na conclusão.| External changes are listed in the conclusion.
Trabalho guardado na cópia|Work saved in the copy
O trabalho ficou guardado e não foi aplicado ao projeto.|The work was saved and was not applied to the project.
Sem alterações aplicadas|No changes applied
A tarefa terminou sem aplicar alterações ao projeto.|The task ended without applying changes to the project.
Cópia privada em pausa|Private copy paused
A tarefa altera ficheiros usados pelo Git. Ao retomar, confirmas esta versão desses ficheiros.|The task changes files used by Git. By resuming, you confirm this version of those files.
Libertar o projeto|Release the project
Pasta de recuperação|Recovery folder
Copiar pasta de recuperação|Copy recovery folder
Esta cópia altera ficheiros usados pelo Git. Ao confirmar, aceitas esta versão destes ficheiros.|This copy changes files used by Git. By confirming, you accept this version of those files.
Confirmar e aplicar|Confirm and apply
Aplicar ao projeto|Apply to the project
Apagar cópia|Delete copy
Apagar esta cópia guardada e o trabalho que contém? Esta ação não altera o projeto e não pode ser desfeita.|Delete this saved copy and the work it contains? This does not change the project and cannot be undone.
Apagar esta tarefa? O diálogo, as versões, os votos e as saídas dos testes desaparecem. A resposta publicada fica na conversa.|Delete this task? Its dialogue, versions, votes and test outputs will be removed. The published response remains in the conversation.
Libertar o projeto sem desfazer? Usa isto só se a pasta privada foi mesmo apagada. O projeto fica como está, possivelmente com parte da versão aplicada, e deixa de ser possível desfazer.|Release the project without undoing changes? Use this only if the private folder was actually deleted. The project stays as it is, possibly with part of the version applied, and undoing it is no longer possible.
Progresso anterior incluído nesta tarefa. As aprovações anteriores não transitam.|Previous progress is included in this task. Earlier approvals do not carry over.
Esclarecimento|Clarification
atual|current
substituída|superseded
 · publicada| · published
avaliação declarada após entrega das capturas|assessment declared after screenshots were delivered
não validado|not validated
 · substituído| · superseded
A saída completa está indisponível. O excerto foi conservado; tenta novamente depois de repor o ficheiro ou o acesso.|The full output is unavailable. The excerpt was preserved; try again after restoring the file or access.
 · início e fim observados| · start and end observed
 · observação parcial| · partial observation
Ver captura · |View screenshot ·\u0020
Captura indisponível ou alterada.|Screenshot unavailable or modified.
Não foi possível apresentar esta captura.|Could not display this screenshot.
 · alterações por validar| · changes awaiting validation
Não foi possível carregar os detalhes desta tarefa. O estado acima é o mais recente recebido.|Could not load this task's details. The status above is the latest received.
Tentar carregar novamente|Try loading again
Tentar apagar tarefa novamente|Try deleting the task again
As proteções devem ser números inteiros iguais ou superiores a 0.|Safeguards must be whole numbers greater than or equal to 0.
Atualiza o servidor para iniciar uma tarefa na cópia privada.|Update the server to start a task in a private copy.
Escolhe dois ou três clientes distintos.|Choose two or three different clients.
Escolhe pelo menos um implementador.|Choose at least one implementer.
`.trim().split('\n').map(line => line.split('|')));
teamEnglish['\n[Saída truncada a 32 000 caracteres]'] = '\n[Output truncated at 32,000 characters]';

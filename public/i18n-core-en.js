export const coreEnglish = Object.fromEntries(`
Repõe em {0}|Resets in {0}
os dois|both
os três|all three
os quatro|all four
todos|everyone
responder a uma pergunta|answer a question
propor a resposta comum|propose the shared answer
rever a resposta comum|review the shared answer
declarar um impasse|declare an impasse
Listar as conversas do projeto|List project conversations
Pesquisar nas conversas do projeto|Search project conversations
A ler|Reading
Ler|Read
A procurar|Searching
Procurar|Search
A listar|Listing
Listar|List
A alterar|Editing
Alterar|Edit
A correr|Running
Correr|Run
A pesquisar na web|Searching the web
Pesquisar na web|Search the web
A abrir|Opening
A delegar num subagente|Delegating to a subagent
Delegar num subagente|Delegate to a subagent
Hydra · a|Hydra ·
A consultar o projeto|Consulting project context
Consultar o projeto|Consult project context
A perguntar-te|Asking you
Perguntar-te|Ask you
A organizar o trabalho|Organising work
Organizar o trabalho|Organise work
A pensar|Thinking
A usar|Using
Usar|Use
ficheiros |files\u0020
em {0}|in {0}
A {0}{1}|{0}{1}
ficheiro|file
ficheiros|files
comando|command
comandos|commands
leu {0}|read {0}
alterou {0}|changed {0}
falhou|failed
falharam|failed
pesquisa no projeto|project search
pesquisas no projeto|project searches
pesquisa na web|web search
pesquisas na web|web searches
ferramenta|tool
ferramentas|tools
passo do Hydra|Hydra step
passos do Hydra|Hydra steps
subagente|subagent
subagentes|subagents
A iniciar o pedido|Starting request
A escrever a resposta|Writing the response
A trabalhar · sem atividade detalhada|Working · no detailed activity
< 0,1 s|< 0.1 s
Quota da conta e do modelo|Account and model quota
Quota partilhada do Codex|Shared Codex quota
Grupo Gemini · Antigravity|Gemini group · Antigravity
Grupo Claude e GPT · Antigravity|Claude and GPT group · Antigravity
Quota usada|Quota used
Último pedido · |Latest request ·\u0020
Envio|Send
Retoma|Resume
Troca|Switch
Passou neste ensaio|Passed this test
Por verificar|Not verified
auditoria pendente|audit pending
auditoria incompleta|audit incomplete
auditoria interrompida|audit interrupted
Orientar|Steer
Redirecionar agora|Redirect now
Enviar depois|Send later
Acrescenta uma orientação ao pedido em curso, sem o cancelar. No OpenCode entra na próxima fronteira entre passos; não interrompe uma resposta ou ferramenta já em execução.|Add guidance to the current request without cancelling it. In OpenCode it arrives at the next step boundary; it does not interrupt a running response or tool.
Orientar na próxima oportunidade|Steer at the next opportunity
O Claude recebe a orientação quando terminarem as ferramentas em curso; pode seguir no próximo ciclo se o atual terminar primeiro.|Claude receives guidance when current tools finish; it may arrive in the next cycle if the current one finishes first.
O Claude reage imediatamente: pode interromper a resposta ou passar ferramentas para segundo plano. Não aprova ações pendentes.|Claude reacts immediately: it may interrupt the response or move tools to the background. This does not approve pending actions.
Interrompe o Antigravity e continua na mesma sessão apenas após confirmar a paragem. Não desfaz ações já executadas.|Interrupt Antigravity and continue in the same session only after confirming it has stopped. Completed actions are not undone.
Guarda a mensagem no HYDRAQ e envia-a após a conclusão do pedido, com as escolhas atuais da sessão. Uma falha ou reinício exige revisão.|Save the message in HYDRAQ and send it after the request finishes, using the current session settings. A failure or restart requires review.
Os MCP externos podem atuar fora do projeto. No Hydra, escolhe também os servidores e os participantes autorizados na configuração da tarefa.|External MCP tools can act outside the project. In Hydra, also choose the authorised servers and participants in the task settings.
Planear é independente do perfil. Cada turno protegido é auditado ao terminar.|Planning is independent of the profile. Each protected turn is audited when it ends.
Delegação|Delegation
Após reinício|After restart
auditoria concluída|audit completed
alterações fora do perfil|changes outside the profile
falha de auditoria|audit failure
Os ensaios listados usam rede e MCP externos desligados. Os percursos por verificar continuam identificados.|The listed tests run with network and external MCP disabled. Unverified paths remain identified.
Percurso|Path
Perfil|Profile
Teste real|Real test
dar a posição inicial|give the initial position
ler o diálogo|read the dialogue
escrever ao parceiro|write to the partner
dizer que está pronto a concluir|say it is ready to finish
Ler a memória do projeto|Read project memory
Ler um excerto de outra conversa|Read an excerpt from another conversation
ação|action
Resumo do raciocínio · Claude|Reasoning summary · Claude
Resumo do raciocínio · Antigravity|Reasoning summary · Antigravity
Raciocínio · Cursor|Reasoning · Cursor
alteração recusada|change rejected
alterações recusadas|changes rejected
A aguardar a tua decisão|Waiting for your decision
Há uma autorização ou pergunta pendente.|An approval request or question is pending.
Ditar mensagem · áudio enviado à Groq|Dictate message · audio sent to Groq
Ditado indisponível neste navegador|Dictation unavailable in this browser
A transcrever na Groq · o texto ficará na caixa para rever e enviar.|Transcribing with Groq · the text will appear in the box for you to review and send.
Reinicia o servidor HYDRAQ e recarrega a página para ativar o ditado.|Restart the HYDRAQ server and reload the page to enable dictation.
Não foi possível preparar o ditado.|Could not prepare dictation.
Este navegador não suporta um formato de gravação compatível.|This browser does not support a compatible recording format.
A gravação excedeu 25 MB. Grava uma mensagem mais curta.|The recording exceeded 25 MB. Record a shorter message.
Falha na gravação do microfone. Tenta novamente.|Microphone recording failed. Try again.
Permite o acesso ao microfone no navegador para ditar.|Allow microphone access in the browser to dictate.
Não foi encontrado um microfone.|No microphone was found.
Não foi possível transcrever a gravação.|Could not transcribe the recording.
O texto transcrito não cabe na mensagem. Envia ou encurta o rascunho antes de voltar a ditar.|The transcription does not fit in the message. Send or shorten the draft before dictating again.
Ditado acrescentado. Revê o texto e carrega em Enviar.|Dictation added. Review the text and press Send.
A transcrição demorou demasiado. Tenta novamente.|Transcription took too long. Try again.
escolhe uma das opções indicadas.|choose one of the listed options.
introduz um número válido.|enter a valid number.
Este pedido requer apenas uma decisão. Para acrescentar instruções, usa a caixa de orientação da tarefa.|This request only needs a decision. To add instructions, use the task's guidance box.
A resposta exige JSON válido. O texto foi conservado; corrige o formato ou recusa o pedido.|The response requires valid JSON. Your text was preserved; correct the format or reject the request.
 (obrigatório)| (required)
Reposição não comunicada|Reset time not reported
Aguarda reposição|Waiting for reset
Sem quotas comunicadas por este cliente.|No quotas reported by this client.
 não comunicado| not reported
O cliente não indicou a hora de reposição|The client did not report a reset time
Catálogo anterior; aguarda nova confirmação.|Previous catalogue; waiting for confirmation.
Quotas não disponíveis nesta consulta.|Quotas unavailable in this query.
Anexar imagens · até 4 imagens de 5 MB · também podes colar ou arrastar|Attach images · up to 4 images of 5 MB · you can also paste or drag
Aguarda o fim do pedido para anexar imagens. As orientações em curso aceitam apenas texto.|Wait for the request to finish before attaching images. Guidance during execution accepts text only.
Podes anexar até quatro imagens por mensagem.|You can attach up to four images per message.
Usa PNG, JPEG ou WebP estático, até 5 MB por imagem.|Use PNG, JPEG or static WebP, up to 5 MB per image.
Não foi possível guardar a imagem.|Could not save the image.
Imagem indisponível ou alterada.|Image unavailable or changed.
Imagem indisponível|Image unavailable
Não foi possível abrir esta imagem.|Could not open this image.
turnos simultâneos na mesma conta|simultaneous turns on the same account
o contador mudou de janela ou foi reposto|the counter changed windows or was reset
faltam leituras comparáveis|comparable readings are missing
Estimativa pela diferença entre leituras do contador da conta ou do grupo. Depende da precisão e atualização do cliente e pode incluir atividade noutros clientes.|Estimate based on the difference between account or group counter readings. Depends on client precision and updates, and may include activity in other clients.
Medição parcial.|Partial measurement.
 sem variação detetada à precisão do contador.| no change detected at the counter's precision.
Sem estimativa. |No estimate.\u0020
 sem estimativa. | no estimate.\u0020
Grupos de limites comunicados pelo Codex|Limit groups reported by Codex
Quota da subscrição Claude|Claude subscription quota
Quota própria do Argon|Argon's own quota
Grupo de quota por identificar|Unidentified quota group
O cliente não disponibiliza estes limites|The client does not provide these limits
por confirmar|unconfirmed
Por consultar|Not checked
Repõe em |Resets in\u0020
 + rede| + network
 · sem rede| · no network
 + MCP externos| + external MCP
 · sem MCP externos| · no external MCP
Em execução|Running
Sucesso|Success
Falha|Failure
Indisponível|Unavailable
Disponível|Available
Suportado|Supported
Não suportado|Not supported
Lido|Read
Escrito|Written
à espera|waiting
o campo «{0}» não é permitido.|field “{0}” is not allowed.
o mínimo é {0}.|the minimum is {0}.
o máximo é {0}.|the maximum is {0}.
introduz no máximo {0} caracteres.|enter at most {0} characters.
A gravar · {0} s · Termina para transcrever (máximo 5 min)|Recording · {0} s · Stop to transcribe (maximum 5 min)
Última consulta: {0} · atualização automática a cada 2 minutos|Last checked: {0} · automatically refreshed every 2 minutes
Verificado {0} · atualização a cada 6 horas.|Checked {0} · refreshed every 6 hours.
`.trim().split('\n').map(line => line.split('|')));

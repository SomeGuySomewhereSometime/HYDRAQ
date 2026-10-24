# Codex original: terminal e HYDRAQ

A HYDRAQ continua a executar o cliente original `codex app-server` por stdio, com autenticação ChatGPT. O terminal original liga-se a um adaptador privado por socket Unix e usa a mesma thread. O servidor da HYDRAQ tem de continuar em execução; o browser/preview pode estar fechado.

Em **Configurações e detalhes → Codex original**, escolhe **Abrir no terminal** depois de concluir um primeiro pedido. Se a janela não abrir, expande o comando e executa-o no teu terminal. Fechar o terminal conserva o trabalho em curso. **Ver comando do terminal** permite voltar a ligar. Para escrever novamente na interface, aguarda a conclusão e escolhe **Continuar na HYDRAQ**. Aprovações e Parar continuam disponíveis na HYDRAQ.

Os pedidos admitidos no terminal percorrem `Providers.send`: memória atual, contexto das passagens, anexos, MCP do projeto e revisões automáticas continuam a ser preparados pela aplicação. O controlo de envio pertence a uma interface por grupo. Não há reenvio automático após entrega incerta. O histórico é recuperado por páginas e aplicado apenas depois de uma leitura completa, sem apagar eventos recebidos entretanto.

**Associar sessão Codex existente** procura apenas na pasta indicada e exige selecionar uma sessão. Fecha primeiro o cliente que detenha a escrita; o adaptador não força a sua libertação. A associação mantém o ID nativo. Texto, respostas, ações e metadados nativos são recuperados; imagens antigas de sessões externas não são automaticamente convertidas para anexos geridos pela HYDRAQ. Imagens enviadas pelo novo terminal passam pelo armazenamento normal da aplicação.

## Compatibilidade e limites

Validado em Linux, Codex CLI **0.159.0**. O adaptador suporta texto, imagens locais, seleção de modelo/raciocínio (no pedido e pelo `/model` só para a sessão), orientação, interrupção e decisões individuais. Modos Plan/multiagente, novos chats/forks, execução direta de comandos fora do pedido, gestão de plugins/configuração e outras operações ainda não integradas são recusados explicitamente. Uma decisão não suportada mantém o pedido pendente e apresenta aviso; podes resolvê-lo na HYDRAQ. Não se promete paridade com todos os comandos do TUI.

A app desktop permanece indisponível. O ensaio com uma instância isolada abriu a interface, mas não validou o seu fluxo completo de autenticação, gestão e execução. Não há botão nem ligação à instalação ativa. Para usar uma sessão externa na HYDRAQ, usa a associação explícita depois de a fechar no cliente original.

## Revisão e provas de 2026-10-23

A revisão do checkpoint identificou e corrigiu:

- Desconexão real provocada pelo catálogo de plugins com aproximadamente 18 MB. O envio usa frames de 64 KiB e limite agregado de 64 MiB; a ligação lenta que ultrapassar o limite continua a ser fechada explicitamente.
- Imagens locais sem MIME no armazenamento e projeção do pedido que removia imagens. A leitura é limitada, rejeita symlinks/ficheiros especiais e preserva os elementos não textuais.
- Recuperação de histórico que publicava estado parcial antes de receber todas as páginas. A nova aplicação é atómica e rejeita um histórico que concorra com eventos novos.
- Propostas de memória que podiam iniciar inferência pela interface enquanto o terminal controlava o grupo.
- Modelo/raciocínio enviados dentro de `collaborationMode.settings` ignorados pelo adaptador. A precedência segue o schema experimental gerado pelo CLI instalado. A página inicial pedida pelo TUI também é devolvida.
- Decisões nativas não suportadas que ficavam sem explicação visível.

Verificações automáticas: **337 testes aprovados**, incluindo 13 específicos da integração. Cobrem exclusão de controlo, contexto atualizado, imagens, catálogo grande, reconexão/aprovações concorrentes, IDs repetidos, paginação falhada, eventos concorrentes, modelos, associação e revisões automáticas. Os clientes das regressões são simulados; a passagem para Claude nesse conjunto não representa implementação ou ensaio real novo de Claude.

Ensaios reais separados: resposta final visível no TUI sem reconexão; chamada MCP `get_project_memory` com resposta correta; volta à HYDRAQ pelo browser e novo pedido concluído; associação num estado isolado e novo arranque preservando **9 turnos, 20 mensagens e o mesmo ID**. Browser Grafite/Atelier a 1440/390 px, comando visível, envio bloqueado durante o controlo do terminal, seleção de sessão e libertação funcionais, sem overflow nem erros de página observados.

Provas locais: `.hydraq/native-terminal-2026-10-23/VALIDACAO.md`. Scripts manuais em `validation/`; `native-live.mjs` e `tui-final.py` podem executar pedidos reais e não fazem parte de `npm test`. Os testes não necessitam de abrir ou reiniciar a instalação desktop do utilizador.

## Investigação de controlo partilhado — 2026-10-24

Ensaio do TUI original 0.159.0 contra `validation/native-probe.mjs`, com perfil temporário, thread efémera e executor simulado, sem inferências:

- Uma mensagem guardada com Tab durante um turno ficou no TUI e chegou como novo `turn/start` depois da conclusão. Nesse fluxo/configuração não foram observados métodos `thread/queue/*`; a existência desses métodos experimentais no schema não demonstra que o TUI os use em todos os modos.
- `/model`, escolhendo guardar apenas na sessão, chamou `thread/settings/update` com modelo, esforço e `collaborationMode.settings`. O TUI também refletiu uma mudança recebida em `thread/settings/updated`. Campos não usados podem ser enviados como `null`; o adaptador futuro terá de validar os valores efetivos e limitar alterações a opções suportadas.
- Um turno injetado pelo servidor apresentou a resposta em direto; a pergunta externa não foi mostrada nesse fluxo. O ensaio não valida sincronização integral do histórico: as páginas de histórico do executor simulado estão vazias.

Estes ensaios não alteram a integração Codex de produção. Para controlo partilhado, falta coordenar admissões e a fila `followups` com a fila local do TUI, manter o bloqueio de mudança de cliente enquanto o terminal estiver associado e decidir cada operação hoje protegida por `assertControl()`. Não encaminhar `thread/queue/start` para fora de `Providers.send()`. A apresentação/recuperação da pergunta externa precisa de validação adicional antes de prometer histórico integral nas duas interfaces.

Provas e limites do ensaio em `.hydraq/terminal-memory-2026-10-24/VALIDACAO.md`.

## `/model` no terminal — 2026-10-24

O `/model` do TUI, com a escolha «só nesta sessão», chama `thread/settings/update`. O adaptador aceita apenas modelo e raciocínio (também em `collaborationMode.settings`, com a mesma precedência dos pedidos), valida-os no catálogo do Codex e guarda-os como definições da conversa para os pedidos seguintes, em qualquer das interfaces. Pasta, acesso, autorizações, permissões, modos Plan/multiagente e restantes opções continuam recusados, sem alterar a sessão. O executor privado mantém a API não experimental, por isso o pedido não é reencaminhado: a HYDRAQ responde e envia ao TUI `thread/settings/updated` com as definições efetivas.

Verificado com o TUI original 0.159.0 contra `validation/native-probe.mjs` em `PROBE_SETTINGS=hydraq` (resposta e notificação construídas pela função de produção, sem inferência): o TUI mostrou «Model changed to gpt-6-sol medium for this session only», o rodapé passou a GPT-6-Sol medium e uma mudança externa posterior continuou a ser refletida. O aviso «could not create PATH aliases» desse ensaio vem do perfil temporário em `/tmp`. A escolha «guardar como predefinição» não foi ensaiada. Provas em `.hydraq/terminal-memory-review-2026-10-24/`.
